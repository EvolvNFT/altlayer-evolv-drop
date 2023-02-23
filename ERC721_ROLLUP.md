# ERC721 Rollup

## Table of Contents

- [I. Introduction](#i-introduction)
- [II. Deploy contracts](#ii-deploy-contracts)
- [III. Mint NFTs on L2](#iii-mint-nfts-on-l2)
  - [A. L2 State Changes](#a-l2-state-changes)
  - [B. Customized L2 State Changes](#b-customized-l2-state-changes)
- [IV. Initiate Rollup on L2](#iv-initiate-rollup-on-l2)
- [V. Finalize Rollup on L1](#v-finalize-rollup-on-l1)

## I. Introduction

This document explains how we can send the ERC721 state changes from L2 to L1 in batches.

## II. Deploy contracts

Let's deploy the following ERC721 contracts:

- Layer 1: [`L1ERC721Token.sol`](/contracts/L1ERC721Token.sol)
- Layer 2: [`L2ERC721Token.sol`](/contracts/L2ERC721Token.sol)

### :warning: **DISCLAIMER**

The sample contracts are purely for demonstration purposes only and is not intended for production use. It has not been audited, tested, or otherwise reviewed for security, performance, or reliability. The code is provided as-is, with no warranties or guarantees of any kind. Use at your own risk."

## III. Mint NFTs on L2

Let's say we minted some token by calling `mint` function in `L2ERC721Token` on L2.

Now we have some state changes.

### A. L2 State Changes

Very minimal ERC721 state change can be represented by key-value pair: `(id, owner)` e.g.,

- `(1, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266)` ➔ Mint `token#1` to `0x...2266`
- `(2, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266)` ➔ Mint `token#2` to `0x...2266`
- `(1, 0x70997970c51812dc3a010c7d01b50e0d17dc79c8)` ➔ Transfer `token#1` to `0x...79c8`
- `(1, 0x0000000000000000000000000000000000000000)` ➔ Burn `token#1` from `0x...79c8`

The final state is the following:

- `(1, 0x0000000000000000000000000000000000000000)` ➔ Burn `token#1` from `0x...79c8`
- `(2, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266)` ➔ Mint `token#2` to `0x...2266`

To capture these state changes, we use the `_emitStateChange` function. `_emitStateChange` will emit `StateChange(bytes,bytes)` events for any state changes we want to finalize on L1.

`L2Lib.sol`

```solidty
    /// @notice Emits a {StateChange} event.
    function _emitStateChange(
        StateContext memory ctx,
        bytes memory key,
        bytes memory value
    ) internal {
        KeyValuePair memory pair = KeyValuePair(key, value);
        ctx._hash = keccak256(abi.encode(ctx._hash, pair));
        emit StateChange(pair);
    }
```

Therefore, every state change in `StateChange(bytes,bytes)` is `tuple(bytes,bytes)`.

For example, a state change of `(2, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266)` is the following:

```json
[
  "0x0000000000000000000000000000000000000000000000000000000000000002",
  "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
]
```

Note that to capture the state changes from `mint`, `transfer`, and `burn`, `L2ERC721` overrides `_afterTokenTransfer` function as the following:

`L2ERC721.sol`

```solidity
    function _afterTokenTransfer(
        address,
        address to,
        uint256 tokenId,
        uint256
    ) internal virtual override {
        StateContext memory ctx = _getWriteContext();
        _emitStateChange(ctx, abi.encode(tokenId), abi.encode(to));
        _saveContext(ctx);
    }
```

If you need just basic minimal format:`(id, owner)`, then you can just inherit `L2ERC721` because this will produce the necessary state changes.

### B. Customized L2 State Changes

Now we know how to produce the ERC721 state changes in very minimal format: `(id, owner)`.

How can we produce more complex state changes?

Let's assume each NFT can have its level and we want this level in L1 after rollup.
To do that, we can customize the key-value pair to include both owner and level: `(id, (owner, level))`.

For example, the new state change format can be the following

- `(1, (0x70997970c51812dc3a010c7d01b50e0d17dc79c8, 0))` ➔ Mint `token#1` to `0x...79c8` (`level is 0`)
- `(1, (0x70997970c51812dc3a010c7d01b50e0d17dc79c8, 1))` ➔ Level up `token#1`

There are two things to check in `L2ERC721Token` to produce consistent state change format.

First, the `levelUp` function in L2ERC721Token should call `_emitStateChange`. Whenever level of a token is increased, we need to capture it.

```
    function levelUp(uint256 tokenId) public {
        require(_exists(tokenId), "invalid token ID");
        uint256 level = levels[tokenId] + 1;
        levels[tokenId] = level;

        StateContext memory ctx = _getWriteContext();
        _emitStateChange(
            ctx,
            abi.encode(tokenId),
            abi.encode(ownerOf(tokenId), level)
        );
        _saveContext(ctx);
    }

```

Secondly, we should override `_afterTokenTransfer` as the following:

```solidity
    function _afterTokenTransfer(
        address,
        address to,
        uint256 tokenId,
        uint256
    ) internal virtual override {
        StateContext memory ctx = _getWriteContext();
        _emitStateChange(
            ctx,
            abi.encode(tokenId),
            abi.encode(to, levels[tokenId])
        );
        _saveContext(ctx);
    }
```

This is to capture state changes from `mint`, `transfer`, and `burn` with consistent state change format.

## IV. Initiate Rollup on L2

Let's assume we have consistent state changes and the following is the final state after minting.

- (`1`, (`0x70997970c51812dc3a010c7d01b50e0d17dc79c8`, `1`)) ➔ Mint `token#1` to `79c8` (`level is 1`)
- (`2`, (`0x70997970c51812dc3a010c7d01b50e0d17dc79c8`, `1`)) ➔ Mint `token#2` to `79c8` (`level is 1`)
- (`3`, (`0x70997970c51812dc3a010c7d01b50e0d17dc79c8`, `1`)) ➔ Mint `token#3` to `79c8` (`level is 1`)

Now that we have some final L2 state changes, let's initiate rollup with the following assumptions:

- domain ID of L1 Bridge is `1`
- domain ID of L2 Bridge is `2`
- Resource ID for rollup operation is `0x0000000000000000000000000000000000000000000000000000000000000000`
- Batch size is `2` (this is to have multiple Merkle leaves)

Only a rollup admin can call `initiateRollup` function of the L2 `L2ERC721` contract:

```soldity
function initiateRollup(
        uint64 destDomainID,
        bytes32 resourceID,
        uint64 batchSize
    )
```

Relayers will query L2 state changes for this rollup and get this final state:

```json
[
  [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
  ],
  [
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
  ],
  [
    "0x0000000000000000000000000000000000000000000000000000000000000003",
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
  ]
]
```

Afterwards, relayer need to construct merkle tree.

Merkle leaves are the keccak256 hash of the bytes of `["uint64", "tuple(bytes,bytes)[]"]` e.g.

```json
[
    "0",
    [
      [
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
      ],
      [
        "0x0000000000000000000000000000000000000000000000000000000000000002",
        "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
      ]
    ]
  ],
```

The batch size decides how much state changes a merkle leaf can contain. When the batch size 2, a Merkle leaf can contain 2 state changes at most.

Therefore, The first Merkle leaf will be `0xffa0658124b5b395f88716b369361fb60abd7b76a1939a3e14b98833fef0aefe`.

The hash is the keccak256 hash of the following bytes:

```text
0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001
```

The above is the bytes of the following

```json
[
    "0",
    [
      [
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
      ],
      [
        "0x0000000000000000000000000000000000000000000000000000000000000002",
        "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
      ]
    ]
  ],
```

The second Merkle leaf will be `0x80f313fbc88226c0b58b42bb05f057dd6522b3261a14202c72f0bc4ac55774a2`.

The hash is the keccak256 hash of the following bytes:

```text
0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000004000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001
```

The above is the bytes of the following

```json
[
  "1",
  [
    [
      "0x0000000000000000000000000000000000000000000000000000000000000003",
      "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001"
    ]
  ]
]
```

With the 2 Merkle leaves, the Merkle root will be `0x95d1ec8c3828302ab58f7103baa08a0701083e8c9752b4e940c2debe9ad458fd`.

```ts
const merkleTree = new MerkleTree(leaves, keccak256, {
  sortPairs: true,
});
```

Once the Merkle tree is constructed, relayer creates a proposal with the root hash in the L1 Bridge contract and relayers vote for that proposal.

Only after the number of vote is sufficient, the proposal with the root hash is valid and the L2 state changes are ready to be finalized on L1.

## V. Finalize Rollup on L1

Now that we have the root hash on L1 to verify the L2 state changes (Merkle leaves) on L1,
we are ready to finalize the state changes for the L1 ERC721 contract.

Anyone can execute the following function in the L1 Bridge contract with valid parameters:

`Bridge.sol`

```solidity
function finalizeRollup(
        uint64 originDomainID,
        bytes32 resourceID,
        uint64 nonce,
        bytes calldata data,
        bytes32[] calldata proof
    )
```

For the first Merkle leaf, the following is the valid parameters of `finalizeRollup`:

```json
{
  "originDomainID": "2",
  "resourceID": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "nonce": "1",
  "data": "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001",
  "proof": [
    "0x80f313fbc88226c0b58b42bb05f057dd6522b3261a14202c72f0bc4ac55774a2"
  ]
}
```

Note that `originDomainID` should be the L2 domain ID.

For the second Merkle leaf, here are the valid parameters of `finalizeRollup`:

```json
{
  "originDomainID": "2",
  "resourceID": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "nonce": "1",
  "data": "0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000004000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000001",
  "proof": [
    "0xffa0658124b5b395f88716b369361fb60abd7b76a1939a3e14b98833fef0aefe"
  ]
}
```

`finalizeRollup` function in `Bridge` will call the `finalizeRollup` function in `L1Lib`.

Once the `keccak256(data)` is verified, it finalizes the L2 state changes on L1 by calling `_finalizeRollup`.

`L1ERC721Token.sol`

```solidity
    function _finalizeRollup(KeyValuePair[] memory pairs, bytes32)
        internal
        virtual
        override
    {
        // Use a local variable to hold the loop computation result.
        uint256 curBurnCount = 0;
        for (uint256 i = 0; i < pairs.length; i++) {
            uint256 tokenId = abi.decode(pairs[i].key, (uint256));
            (address account, uint256 level) = abi.decode(
                pairs[i].value,
                (address, uint256)
            );

            if (account == address(0)) {
                curBurnCount += 1;
            } else {
                _mint(account, tokenId);
                levels[tokenId] = level;
            }
        }
        _incrementTotalMinted(pairs.length);
        _incrementTotalBurned(curBurnCount);
    }
```

Note that the state variable `levels` will be changed by the `_finalizeRollup`.
