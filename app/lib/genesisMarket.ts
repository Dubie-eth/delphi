import { parseAbi, type Address } from "viem";
import { TESTNET } from "./testnet";

export const GENESIS_MARKET_ADDRESS =
  "0x0a21Ac6E01638b0437e5066984542F8761Bd3200" as Address;

/** Market deploy tx block on Robinhood testnet (from README handoff). */
export const GENESIS_MARKET_DEPLOY_BLOCK = BigInt(141066578);

export const GENESIS_TIER_NAMES = ["Seed", "Bronze", "Silver", "Gold", "Oracle"] as const;

export const genesisChain = {
  id: TESTNET.chainId,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET.rpc] } },
} as const;

export const genesisNftAbi = parseAbi([
  "function renderer() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event MetadataUpdate(uint256 _tokenId)",
]);

export const genesisMarketAbi = parseAbi([
  "function networkStats(address renderer) view returns ((uint256 totalSupply, uint256 staked, uint256 running, uint256 totalPoints, uint256[5] tierCounts, uint256 revoked, uint256 floorPrice, uint256 validListings, uint256 salesCount, uint256 salesVolume))",
  "function listings(uint256 id) view returns (address seller, uint96 price)",
  "function isListingValid(uint256 id) view returns (bool)",
  "function isStaked(uint256 id) view returns (bool)",
  "function offers(uint256 id, address buyer) view returns (uint128 amount, uint64 expiry)",
  "function buy(uint256 id) payable",
  "function list(uint256 id, uint96 price)",
  "function updatePrice(uint256 id, uint96 price)",
  "function cancel(uint256 id)",
  "function makeOffer(uint256 id, uint64 expiry) payable",
  "function cancelOffer(uint256 id)",
  "function acceptOffer(uint256 id, address buyer, uint256 minAmount)",
  "event Listed(uint256 indexed id, address indexed seller, uint256 price)",
  "event PriceUpdated(uint256 indexed id, address indexed seller, uint256 price)",
  "event ListingCancelled(uint256 indexed id, address indexed seller)",
  "event Sale(uint256 indexed id, address indexed seller, address indexed buyer, uint256 price, address royaltyTo, uint256 royalty, bool viaOffer)",
  "event OfferMade(uint256 indexed id, address indexed buyer, uint256 amount, uint64 expiry)",
  "event OfferCancelled(uint256 indexed id, address indexed buyer, uint256 amount)",
]);

export type NetworkStats = {
  totalSupply: bigint;
  staked: bigint;
  running: bigint;
  totalPoints: bigint;
  tierCounts: readonly [bigint, bigint, bigint, bigint, bigint];
  revoked: bigint;
  floorPrice: bigint;
  validListings: bigint;
  salesCount: bigint;
  salesVolume: bigint;
};

export type TokenMeta = {
  name: string;
  image: string | null;
  tier: string;
  status: string;
};

export type TokenOffer = {
  buyer: Address;
  amount: bigint;
  expiry: bigint;
};

export function shortAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function explorerAddress(addr: string): string {
  return `${TESTNET.explorer}/address/${addr}`;
}

export function explorerTx(hash: string): string {
  return `${TESTNET.explorer}/tx/${hash}`;
}

export function parseTokenUriJson(uri: string): TokenMeta | null {
  if (!uri.startsWith("data:application/json")) return null;
  const comma = uri.indexOf(",");
  if (comma === -1) return null;
  try {
    const json = JSON.parse(atob(uri.slice(comma + 1)));
    const attrs: { trait_type?: string; value?: string | number }[] = json.attributes ?? [];
    const pick = (t: string) => attrs.find((a) => a.trait_type === t)?.value;
    return {
      name: typeof json.name === "string" ? json.name : "Genesis Node",
      image: typeof json.image === "string" ? json.image : null,
      tier: String(pick("Tier") ?? "—"),
      status: String(pick("Status") ?? "—"),
    };
  } catch {
    return null;
  }
}

export function staticFallbackImage(tokenId: number): string | null {
  if (tokenId === 1) return "/genesis/live-1.png";
  if (tokenId === 2) return "/genesis/live-2.png";
  return null;
}

export async function resolveRendererAddress(
  readRenderer: () => Promise<Address>
): Promise<Address> {
  const r = await readRenderer();
  if (r === "0x0000000000000000000000000000000000000000") {
    return TESTNET.genesisNodeNft;
  }
  return r;
}
