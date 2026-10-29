import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  type Address,
} from "viem";
import { genesisChain } from "./genesisMarket";
import { TESTNET } from "./testnet";

const publicClient = createPublicClient({
  chain: genesisChain,
  transport: http(TESTNET.rpc),
});

export const BATCH_ANCHOR_MAX_AGE_SEC = 15 * 60;

export type BatchAnchor = {
  anchorBlock: number;
  blockHash: `0x${string}`;
  blockTimestampSec: number;
};

export function freivaldsSeedFromAnchor(
  blockHash: `0x${string}`,
  tokenId: number,
  wallet: Address
): number {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [blockHash, BigInt(tokenId), wallet]
  );
  const hash = keccak256(encoded);
  return Number(BigInt(`0x${hash.slice(2, 10)}`)) >>> 0;
}

export async function fetchLatestBatchAnchor(): Promise<BatchAnchor> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  if (!block.hash) throw new Error("Latest block has no hash.");
  return {
    anchorBlock: Number(block.number),
    blockHash: block.hash,
    blockTimestampSec: Number(block.timestamp),
  };
}

export function assertAnchorFresh(anchor: BatchAnchor, nowSec = Math.floor(Date.now() / 1000)): void {
  if (nowSec - anchor.blockTimestampSec > BATCH_ANCHOR_MAX_AGE_SEC) {
    throw new Error(
      `Anchor block is older than ${BATCH_ANCHOR_MAX_AGE_SEC / 60} minutes — restart the batch.`
    );
  }
}
