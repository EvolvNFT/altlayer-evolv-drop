import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { ethers } from "hardhat";

import keccak256 from "keccak256";

import {
  constructMerkleTree,
  getL2StateChanges,
} from "../../scripts/relay/lib";

const deployUpgradable = async (ethers: any, name: string, args: any[]) => {
  const contract = await ethers.deployContract(name, []);
  await contract.deployed();
  const tx = await contract.initialize(...args);
  await tx.wait();
  return contract;
};

const ALICE = 0;
const BOB = 1;

const BATCH_SIZE = 2;

describe("rollup", function () {
  const l1DomainID = 1;
  const l2DomainID = 2;

  let L2ERC721MintableInstance: Contract;
  let L1ERC721MintableInstance: Contract;

  let signers: Signer[];

  // deploy L1 and L2 contracts on a local network.
  beforeEach(async () => {
    signers = await ethers.getSigners();
    [L1ERC721MintableInstance, L2ERC721MintableInstance] = await Promise.all([
      deployUpgradable(ethers, "L1ERC721Token", [
        await signers[ALICE].getAddress(),
        "Alice",
        "ALICE",
        "https://demons.mypinata.cloud/ipfs/QmZnv6kFCRHRaCiGGbcq55jzDArhnsy8d641H8bjuDc89Z/",
        ".png",
      ]),
      deployUpgradable(ethers, "L2ERC721Token", [
        await signers[ALICE].getAddress(),
        "Alice",
        "ALICE",
        await signers[ALICE].getAddress(),
        await signers[ALICE].getAddress(),
        3,
        1,
        10,
        3,
        "https://demons.mypinata.cloud/ipfs/QmZnv6kFCRHRaCiGGbcq55jzDArhnsy8d641H8bjuDc89Z/",
        ".png",
      ]),
    ]);

    await Promise.all(
      [L1ERC721MintableInstance, L2ERC721MintableInstance].map((x) =>
        x.deployed()
      )
    );

    expect(await L1ERC721MintableInstance.totalMinted()).to.equal("0");
  });

  it("finalize rollup with customized state changes", async () => {
    const mintAmount = 3;
    const rollupResourceID =
      "0x0000000000000000000000000000000000000000000000000000000000000000";

    for (let i = 1; i <= mintAmount; i++) {
      const mintTx = await L2ERC721MintableInstance.claimNFT();
      let receipt = await mintTx.wait();
      expect(await L2ERC721MintableInstance.totalSupply()).to.equal(i);

      let wants = [
        {
          event: "Transfer",
          data: async () => undefined, // ignore data
        },
        {
          event: "StateChange",
          data: async () => {
            const k = ethers.utils.AbiCoder.prototype.encode(["uint256"], [i]);
            const v = ethers.utils.AbiCoder.prototype.encode(
              ["address", "uint256"],
              [await signers[ALICE].getAddress(), "0"]
            );

            const data = ethers.utils.AbiCoder.prototype.encode(
              ["tuple(bytes, bytes)"],
              [[k, v]]
            );

            return data;
          },
        },
        {
          event: "BlockNumber",
          data: async () => undefined, // ignore data
        },
      ];

      // level up
      const levelUpTx = await L2ERC721MintableInstance.levelUp(i);
      receipt = await levelUpTx.wait();
      expect(await L2ERC721MintableInstance.levels(i)).to.equal("1");

      // transfer
      const transferFromTx = await L2ERC721MintableInstance[
        "safeTransferFrom(address,address,uint256)"
      ](await signers[ALICE].getAddress(), await signers[BOB].getAddress(), i);

      receipt = await transferFromTx.wait();
      wants = [
        {
          event: "Approval",
          data: async () => undefined, // ignore data
        },
        {
          event: "Transfer",
          data: async () => undefined, // ignore data
        },
        {
          event: "StateChange",
          data: async () => {
            const k = ethers.utils.AbiCoder.prototype.encode(["uint256"], [i]);
            const v = ethers.utils.AbiCoder.prototype.encode(
              ["address", "uint256"],
              [await signers[BOB].getAddress(), "1"]
            );

            const data = ethers.utils.AbiCoder.prototype.encode(
              ["tuple(bytes, bytes)"],
              [[k, v]]
            );

            return data;
          },
        },
      ];

      for (const [i, v] of receipt.events.entries()) {
        expect(v.event).to.equal(wants[i].event);
        if (await wants[i].data()) {
          expect(v.data).to.equal(await wants[i].data());
        }
      }

      for (const [i, v] of receipt.events.entries()) {
        expect(v.event).to.equal(wants[i].event);
        if (await wants[i].data()) {
          expect(v.data).to.equal(await wants[i].data());
        }
      }
    }

    const contractAsAlice = L2ERC721MintableInstance.connect(signers[ALICE]);

    const rollupTx = await contractAsAlice.initiateRollup(
      l1DomainID,
      rollupResourceID,
      BATCH_SIZE
    );

    let receipt = await rollupTx.wait();
    const l2RollupTxHash = receipt.transactionHash;

    const { destDomainId, resourceId, nonce, pairs, batchSize } =
      await getL2StateChanges(ethers.provider, l2RollupTxHash, false);

    expect(resourceId).to.equal(rollupResourceID);
    expect(destDomainId).to.equal(l1DomainID);

    const { merkleTree, encodedStates } = constructMerkleTree(pairs, batchSize);
    const rootHash = merkleTree.getHexRoot();

    const paramsList = [];
    for (const encoded of encodedStates) {
      const proof = merkleTree.getHexProof(keccak256(encoded));
      paramsList.push({
        l2DomainID,
        rollupResourceID,
        nonce,
        proof,
        rootHash,
        encoded,
      });
    }

    for (const [, params] of paramsList.entries()) {
      const tx = await L1ERC721MintableInstance.finalizeRollup(
        ...Object.values(params)
      );
      receipt = await tx.wait();
    }

    for (let i = 1; i <= mintAmount; i++) {
      const result = await L1ERC721MintableInstance.levels(i);
      expect(result).to.equal("1");
    }
    expect(await L1ERC721MintableInstance.totalSupply()).to.equal(mintAmount);
  });
});
