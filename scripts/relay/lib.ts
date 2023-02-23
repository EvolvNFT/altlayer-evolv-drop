// @ts-nocheck

import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";

import L2_ERC721_ABI from "./abi/ERC721PresetL2.json";

export const EMPTY_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export const getL2StateChanges = async (
  l2Provider,
  l2EventTxHash,
  isBridge = true,
  batchQuerySize = 5000,
  retryIntervalInMs = 1000,
  retries = 5
) => {
  const tx = await l2Provider.getTransaction(l2EventTxHash);
  const receipt = await tx.wait();

  const rollupEventName = isBridge ? "InitiateRollup" : "Rollup";

  const event = receipt.logs.find(
    (x) =>
      x.topics[0] ===
      ethers.utils.id(
        `${rollupEventName}(uint64,bytes32,uint64,uint64,uint256,bytes32)`
      )
  );

  const endBlock = ethers.BigNumber.from(event.blockNumber);

  const [
    destDomainId,
    resourceId,
    nonce,
    batchSizeBigNum,
    startBlock,
    stateChangeHash,
  ] = ethers.utils.AbiCoder.prototype.decode(
    ["uint64", "bytes32", "uint64", "uint64", "uint256", "bytes32"],
    event.data
  );

  const batchSize = Number(batchSizeBigNum.toString());
  const tokenAddress = tx.to;

  console.log("L2 Token Address:", tokenAddress);
  console.log("Batch Size:", batchSize);
  console.log("Start Block:", startBlock.toString());
  console.log("End Block:", endBlock.toString());

  const contract = new ethers.Contract(tokenAddress, L2_ERC721_ABI, l2Provider);

  let stateChanges = [];

  let start = startBlock;
  while (start.lt(endBlock)) {
    const limit = start.add(batchQuerySize).sub(1);
    const end = limit.gt(endBlock) ? endBlock : limit;

    console.log(`Query from ${start.toString()} to ${end.toString()}`);

    await runWithRetries(
      async () => {
        const chunkedStateChanges = await contract.queryFilter(
          contract.filters.StateChange(),
          start.toHexString(),
          end.toHexString()
        );
        console.log(stateChanges.length);

        stateChanges = [...stateChanges, ...chunkedStateChanges];
        start = end.add(1);
      },
      retryIntervalInMs,
      retries
    );
  }

  stateChanges = stateChanges.map((x) => x.args[0]);

  console.log("Total State Changes:", stateChanges.length);

  stateChanges.reduce((acc, cur) => {
    const [k, v] = cur;
    acc[k] = v;
    return acc;
  }, {});

  // Validate state changes
  const actualStateChangeHash = stateChanges.reduce((acc, cur) => {
    const [k, v] = cur;
    const state = ethers.utils.AbiCoder.prototype.encode(
      ["bytes32", "tuple(bytes, bytes)"],
      [acc, [k, v]]
    );

    const result = "0x" + keccak256(state).toString("hex");
    return result;
  }, EMPTY_BYTES32);

  if (stateChangeHash !== actualStateChangeHash) {
    throw Error(
      `invalid state change hash\nexpected:${stateChangeHash}\ngot: ${actualStateChangeHash}`
    );
  }

  const finalState = stateChanges.reduce((acc, cur) => {
    const [k, v] = cur;
    acc[k] = v;
    return acc;
  }, {});

  const pairs = Object.entries(finalState).sort((a, b) =>
    ethers.BigNumber.from(a[0]).lt(ethers.BigNumber.from(b[0])) ? -1 : 1
  );

  return { destDomainId, resourceId, nonce, pairs, batchSize };
};

export const constructMerkleTree = (pairs, batchSize) => {
  const batches = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    batches.push(pairs.slice(i, i + batchSize));
  }

  const encodedStates = [];
  const leaves = [];

  for (const [batchIndex, batch] of batches.entries()) {
    const encodedState = ethers.utils.AbiCoder.prototype.encode(
      ["uint64", "tuple(bytes,bytes)[]"],
      [batchIndex, batch]
    );
    encodedStates.push(encodedState);
    leaves.push("0x" + keccak256(encodedState).toString("hex"));
  }

  const merkleTree = new MerkleTree(leaves, keccak256, {
    sortPairs: true,
  });

  return { merkleTree, encodedStates };
};

export const waitFor = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const runWithRetries = async (fn, intervalInMs, retries) => {
  if (retries === 0) {
    throw Error("no retries left");
  }

  try {
    await fn();
  } catch (error) {
    console.error(error);

    console.log("Remaining Retries: ", retries - 1);
    console.log(`Wait for ${intervalInMs} ms`);
    await waitFor(intervalInMs);
    await runWithRetries(fn, intervalInMs, retries - 1);
  }
};
