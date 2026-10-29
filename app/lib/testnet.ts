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
  genesisNodeNft: "0xFB2FfD93227CD50C059389B0057EA11cF9da0D29",
  genesisMarket: "0x0a21Ac6E01638b0437e5066984542F8761Bd3200",
  nodeBondStaking: "0x6A0131D623705adaca5b8b575D5567de785C0cDE",
  nodePoints: "0x50e9285a08de369faa621Dfe23De3076d9B04A18",
  rewardPool: "0xFb9c1760DdeaC7f91aD62A5362B84d00fF58657b",
  usagePayment: "0x2A6504A6123741a6EAF9548e22d59f3FD7b0340C",
  guardianRegistry: "0x474F0a3831A00b2FC5447bE43B7b1bb25C3F6e38",
  vaultSafe: "0x012eE6BFd29d5Df16a8a7c0941D4584C6c11d03B",
  /** stories260K model hash used by DelphiTasks on testnet */
  modelHash: "0xac5d7d65ab0c3ae4111fd522846038a82efd931548d9dea5d22da64307b038ca",
  faucetUrl: "https://faucet.testnet.chain.robinhood.com/",
} as const;

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
