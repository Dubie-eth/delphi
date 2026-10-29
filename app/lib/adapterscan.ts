// Adapterscan / ERC-8004 Identity Adapter (Unruggable Labs) on Robinhood Chain mainnet (4663).
// An NFT's holder registers it as an agent identity through the adapter. Only the holder can: the adapter checks
// ownerOf(tokenId) == msg.sender. Adapterscan indexes registrations and shows stars, ratings and reviews.
import { GENESIS_MAINNET } from "./genesisContracts";

export const ADAPTERSCAN = {
  chainId: 4663,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  adapter: "0x000000009d62675362a58911e3f32FEcf46F5E18" as `0x${string}`,
  /** the first Delphi NFT (stories260K), registered by its holder */
  delphiMainnet: "0xaad879471292d8c3ab7500b0ba05d1d2dd483ef0" as `0x${string}`,
  site: "https://adapterscan.com",
  STANDARD_ERC721: 0,
};

/** which collection: "genesis" = Delphi Genesis Node cards (default), "delphi" = the first Delphi NFT */
export type IdentityCollection = "genesis" | "delphi";
export const collectionAddress = (c: IdentityCollection) =>
  (c === "delphi" ? ADAPTERSCAN.delphiMainnet : GENESIS_MAINNET.genesisNodeNft) as `0x${string}`;

export const hashBindingAbi = [
  {
    type: "function",
    name: "hashBinding",
    stateMutability: "view",
    inputs: [
      { name: "standard", type: "uint8" },
      { name: "boundAddress", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** emit-only registration (no ERC-8004 token minted); holder-only. TokenStandard ERC721 = 0. */
export const counterfactualRegisterAbi = [
  {
    type: "function",
    name: "counterfactualRegister",
    stateMutability: "nonpayable",
    inputs: [
      { name: "standard", type: "uint8" },
      { name: "tokenContract", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "agentURI", type: "string" },
    ],
    outputs: [{ name: "registrationHash", type: "bytes32" }],
  },
] as const;

export const identityUrl = (ubid: string) => `${ADAPTERSCAN.site}/identity/${ubid}`;
/** the card's ERC-8004 registration file (its agent: role, wallet, soul, live status) */
export const agentUriFor = (tokenId: number) => `https://www.delphi.site/api/agents/${tokenId}/card.json`;

export interface IdentityStatus {
  tokenId: number;
  collection: IdentityCollection;
  ubid: string;
  url: string;
  /** Adapterscan has a record for it (registered or counterfactual) */
  indexed: boolean;
  claimed: boolean;
  stars: number;
  ratingAverage: number | null;
  reviews: number;
}
