import { GENESIS_MAINNET } from "./genesisContracts";

// Delphi testnet (Robinhood Chain testnet, chain 46630). Public addresses only.
export const TESTNET = {
  chainId: 46630,
  rpc: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  delphi: "0x0Cc213241ACdC263cd3cc4A14359c53bA453F452",
  publicMinter: "0xBeC68574128b120a0B78489F11429CF4B0030efD",
  pairing: "0x9cf4f4179572173957063260f8918Ba373DdF533",
  tasks: "0x18A498ded4110241052A307F067A69400f1419fe",
  intake: "0xc67C235d80aE54BdFC81D44d2bc904073658461B",
  intakeV1: "0x14D205d983623696f3371F9B30be103C5d1bfD68",
  startBlock: 136639096,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  /** testnet Genesis NFT: the testnet market/gallery. Nodes use `nodeCards` (the mainnet mirror once the peg is live). */
  genesisNodeNft: "0xFB2FfD93227CD50C059389B0057EA11cF9da0D29",
  /** card contract the node stack stakes: MainnetMirror (node #N = mainnet card #N, owned by its mainnet holder) once
   *  NEXT_PUBLIC_PEG_MIRROR is set, else the testnet NFT */
  nodeCards: (process.env.NEXT_PUBLIC_PEG_MIRROR || "0xFB2FfD93227CD50C059389B0057EA11cF9da0D29") as `0x${string}`,
  genesisMarket: "0x0a21Ac6E01638b0437e5066984542F8761Bd3200",
  nodeBondStaking: (process.env.NEXT_PUBLIC_PEG_STAKING || "0x6A0131D623705adaca5b8b575D5567de785C0cDE") as `0x${string}`,
  /** NodePointsV3 / RewardPoolV3 once the open network is deployed (env), else v2 */
  nodePoints: (process.env.NEXT_PUBLIC_OPEN_POINTS || "0x50e9285a08de369faa621Dfe23De3076d9B04A18") as `0x${string}`,
  rewardPool: (process.env.NEXT_PUBLIC_OPEN_POOL || "0xFb9c1760DdeaC7f91aD62A5362B84d00fF58657b") as `0x${string}`,
  /** v2 points/pool: lifetime totals keep counting them after the switch to v3 */
  nodePointsV2: "0x50e9285a08de369faa621Dfe23De3076d9B04A18",
  /** every points contract cards earned on before the current one: lifetime points and jobs add them all up */
  pointsHistory: ["0x50e9285a08de369faa621Dfe23De3076d9B04A18", "0xD68c15ce806aF24D19218921ad5d306b97fB6b35", "0x1FBd1B8cA95571F02208EE59D2a370A61f662f1b"] as `0x${string}`[],
  rewardPoolV2: "0xFb9c1760DdeaC7f91aD62A5362B84d00fF58657b",
  usagePayment: "0x2A6504A6123741a6EAF9548e22d59f3FD7b0340C",
  guardianRegistry: (process.env.NEXT_PUBLIC_PEG_GUARDIANS || "0x474F0a3831A00b2FC5447bE43B7b1bb25C3F6e38") as `0x${string}`,
  vaultSafe: "0x012eE6BFd29d5Df16a8a7c0941D4584C6c11d03B",
  /** stories260K model hash used by DelphiTasks on testnet */
  modelHash: "0xac5d7d65ab0c3ae4111fd522846038a82efd931548d9dea5d22da64307b038ca",
  faucetUrl: "https://faucet.testnet.chain.robinhood.com/",
} as const;

/** true once node ownership follows mainnet (node #N = mainnet card #N) */
export const PEG_LIVE = !!process.env.NEXT_PUBLIC_PEG_MIRROR;

/** Network checker credits at most this many Freivalds checks per Genesis card per UTC day. */
export const NODE_CHECKS_PER_CARD_PER_DAY = 23_000;

/** Robinhood mainnet chain + Delphi agent; Genesis NFT/registry/renderer live in `genesisContracts.ts`. */
export const MAINNET = {
  chainId: GENESIS_MAINNET.chainId,
  rpc: GENESIS_MAINNET.rpc,
  explorer: GENESIS_MAINNET.explorer,
  delphi: "0xaad879471292d8c3ab7500b0ba05d1d2dd483ef0",
  genesisNodeNft: GENESIS_MAINNET.genesisNodeNft,
  guardianRegistry: GENESIS_MAINNET.guardianRegistry,
  genesisRenderer: GENESIS_MAINNET.genesisRenderer,
  multicall3: GENESIS_MAINNET.multicall3,
} as const;

export const TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Amethyst", "Radiant"] as const;
export const WEIGHTS = [1, 2, 4, 8, 16, 32] as const;

export function getChainLinks(chainId: number, contract: string, tokenId: number, walletAddress?: string) {
  if (chainId === MAINNET.chainId) {
    return {
      nft: {
        label: "View NFT",
        url: `https://opensea.io/item/robinhood/${contract}/${tokenId}`,
      },
      wallet: walletAddress ? {
        label: "Agent wallet",
        url: `${MAINNET.explorer}/address/${walletAddress}`,
      } : undefined,
    };
  } else {
    return {
      nft: {
        label: "View NFT",
        url: `${TESTNET.explorer}/token/${contract}/instance/${tokenId}`,
      },
      wallet: walletAddress ? {
        label: "Agent wallet",
        url: `${TESTNET.explorer}/address/${walletAddress}`,
      } : undefined,
    };
  }
}
