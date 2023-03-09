// @ts-nocheck

import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";

export const EMPTY_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export enum PROPOSAL_STATUS {
  // eslint-disable-next-line no-unused-vars
  Inactive,
  // eslint-disable-next-line no-unused-vars
  Active,
  // eslint-disable-next-line no-unused-vars
  Passed,
  // eslint-disable-next-line no-unused-vars
  Executed,
  // eslint-disable-next-line no-unused-vars
  Cancelled,
}

const l2LibABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "uint64",
        name: "destDomainID",
        type: "uint64",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "resourceID",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "epoch",
        type: "uint64",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "batchSize",
        type: "uint64",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "startBlock",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "stateChangeHash",
        type: "bytes32",
      },
    ],
    name: "Rollup",
    type: "event",
  },

  {
    inputs: [
      {
        internalType: "uint64",
        name: "epoch_",
        type: "uint64",
      },
      {
        internalType: "uint256",
        name: "startID",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "querySize",
        type: "uint256",
      },
    ],
    name: "stateChanges",
    outputs: [
      {
        components: [
          {
            internalType: "bytes",
            name: "key",
            type: "bytes32",
          },
          {
            internalType: "bytes",
            name: "value",
            type: "bytes",
          },
        ],
        internalType: "struct KeyValuePair[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint64",
        name: "epoch_",
        type: "uint64",
      },
    ],
    name: "totalStateChanges",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

export const getL2StateChanges = async (
  l2Provider,
  l2EventTxHash,
  isBridge = true,
  querySize = 25n,
  retryIntervalInMs = 1000,
  retries = 5
) => {
  const tx = await l2Provider.getTransaction(l2EventTxHash);
  const receipt = await tx.wait();

  const rollupEventName = isBridge ? "InitiateRollup" : "Rollup";

  const tokenRollupEvent = receipt.logs.find(
    (x) =>
      x.topics[0] ===
      ethers.utils.id(`Rollup(uint64,bytes32,uint64,uint64,uint256,bytes32)`)
  );

  const [, , epoch, , ,] = ethers.utils.AbiCoder.prototype.decode(
    ["uint64", "bytes32", "uint64", "uint64", "uint256", "bytes32"],
    tokenRollupEvent.data
  );

  const event = receipt.logs.find(
    (x) =>
      x.topics[0] ===
      ethers.utils.id(
        `${rollupEventName}(uint64,bytes32,uint64,uint64,uint256,bytes32)`
      )
  );

  const [destDomainId, resourceId, nonce, batchSizeBigNum, ,] =
    ethers.utils.AbiCoder.prototype.decode(
      ["uint64", "bytes32", "uint64", "uint64", "uint256", "bytes32"],
      event.data
    );

  const batchSize = Number(batchSizeBigNum.toString());
  const tokenAddress = tx.to;

  console.log("L2 Token Address:", tokenAddress);
  console.log("Batch Size:", batchSize);

  const contract = new ethers.Contract(tokenAddress, l2LibABI, l2Provider);

  let stateChanges = [];

  const totalStateChanges = await contract.totalStateChanges(epoch);

  console.log("Expected Total State Changes", totalStateChanges.toString());

  let i = 0n;

  while (totalStateChanges.gte(i)) {
    const args = [epoch, i, querySize].map((x) => x.toString());
    await runWithRetries(
      async () => {
        const states = await contract.stateChanges(...args);
        stateChanges = [...stateChanges, ...states];
      },
      retryIntervalInMs,
      retries
    );
    i += querySize;
  }

  console.log("Actual Total State Changes:", stateChanges.length);

  const pairs = stateChanges.sort((a, b) =>
    ethers.BigNumber.from(a[0]).lt(ethers.BigNumber.from(b[0])) ? -1 : 1
  );

  return { destDomainId, resourceId, nonce, pairs, batchSize };
};

export const constructMerkleTree = (pairs, batchSize) => {
  const chunks = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    chunks.push(pairs.slice(i, i + batchSize));
  }

  const values = [];
  const hashedValues = [];

  for (const [i, v] of chunks.entries()) {
    const value = ethers.utils.AbiCoder.prototype.encode(
      ["uint64", "tuple(bytes32,bytes)[]"],
      [i, v]
    );
    values.push(value);
    const hashedValue = keccak256(value);
    hashedValues.push(hashedValue.toString("hex"));
  }

  const merkleTree = new MerkleTree(hashedValues, keccak256, {
    sortPairs: true,
  });

  return { merkleTree, values, hashedValues };
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
