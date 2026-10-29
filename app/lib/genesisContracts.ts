import type { Address } from "viem";

/**
 * Genesis Node mainnet deployment (v3 — any wallet type can mint, including smart accounts / EIP-7702).
 *
 * Swap contracts in one place:
 * - Edit the `GENESIS_MAINNET_V3` literals below, or
 * - Set optional public env vars (same keys) for preview/prod without code changes:
 *   NEXT_PUBLIC_GENESIS_NODE_NFT_MAINNET
 *   NEXT_PUBLIC_GENESIS_GUARDIAN_REGISTRY_MAINNET
 *   NEXT_PUBLIC_GENESIS_RENDERER_MAINNET
 *   NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC
 */
const GENESIS_MAINNET_V3 = {
  chainId: 4663,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://explorer.robinhood.com",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  genesisNodeNft: "0xEf03a7A78E303eE47Ef6c605e6BfD4d88d823423",
  guardianRegistry: "0xddF4e14Ea9f825FA1823c0717d2bF4933461195c",
  genesisRenderer: "0x3106b9ba058B2b53B170Dcd900cE2c81D15bAe87",
} as const;

function addrFromEnv(envKey: string, fallback: string): Address {
  const v = typeof process !== "undefined" ? process.env[envKey] : undefined;
  if (v && /^0x[a-fA-F0-9]{40}$/.test(v)) return v as Address;
  return fallback as Address;
}

function rpcFromEnv(fallback: string): string {
  const v = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC : undefined;
  if (v && v.startsWith("http")) return v;
  return fallback;
}

/** Live mainnet Genesis stack — point env vars or V3 literals at the next deployment. */
export const GENESIS_MAINNET = {
  chainId: GENESIS_MAINNET_V3.chainId,
  rpc: rpcFromEnv(GENESIS_MAINNET_V3.rpc),
  explorer: GENESIS_MAINNET_V3.explorer,
  multicall3: GENESIS_MAINNET_V3.multicall3 as Address,
  genesisNodeNft: addrFromEnv("NEXT_PUBLIC_GENESIS_NODE_NFT_MAINNET", GENESIS_MAINNET_V3.genesisNodeNft),
  guardianRegistry: addrFromEnv(
    "NEXT_PUBLIC_GENESIS_GUARDIAN_REGISTRY_MAINNET",
    GENESIS_MAINNET_V3.guardianRegistry
  ),
  genesisRenderer: addrFromEnv("NEXT_PUBLIC_GENESIS_RENDERER_MAINNET", GENESIS_MAINNET_V3.genesisRenderer),
} as const;
