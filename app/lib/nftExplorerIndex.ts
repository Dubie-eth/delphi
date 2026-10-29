import { createPublicClient, http, parseAbi, type Address } from "viem";
import { genesisChain } from "./genesisMarket";
import { MAINNET, TESTNET } from "./testnet";
import type { ProfileNftOption } from "./nftProfileScan";
import { classifyProfileNft } from "./nftProfileScan";
import { NFT_PLACEHOLDER_IMAGE, normalizeImageUrl, resolveTokenUriMetadata } from "./nftMetadataResolve";

const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

type ExplorerNftItem = {
  id: string;
  image_url?: string | null;
  metadata?: { name?: string | null };
  token?: {
    address_hash?: string;
    name?: string | null;
    type?: string;
  };
};

function explorerBase(chainId: number): string | null {
  if (chainId === TESTNET.chainId) return "https://explorer.testnet.chain.robinhood.com";
  if (chainId === MAINNET.chainId) return "https://explorer.robinhood.com";
  return null;
}

/**
 * Blockscout-style indexer: display discovery only. Each hit is verified with `ownerOf` on-chain
 * before we show it (so the indexer cannot spoof holdings).
 */
export async function fetchWalletNftsFromExplorer(
  wallet: Address,
  chainId: number
): Promise<ProfileNftOption[]> {
  const base = explorerBase(chainId);
  if (!base) return [];

  const items: ExplorerNftItem[] = [];
  let pageParams: Record<string, string> | null = null;

  for (let page = 0; page < 6; page++) {
    const qs = new URLSearchParams({ type: "ERC-721" });
    if (pageParams) {
      for (const [k, v] of Object.entries(pageParams)) qs.set(k, v);
    }
    const res = await fetch(`${base}/api/v2/addresses/${wallet}/nft?${qs}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) break;
    const data = (await res.json()) as {
      items?: ExplorerNftItem[];
      next_page_params?: Record<string, string> | null;
    };
    if (!data.items?.length) break;
    items.push(...data.items);
    pageParams = data.next_page_params ?? null;
    if (!pageParams) break;
  }

  if (!items.length) return [];

  const client = createPublicClient({
    chain:
      chainId === TESTNET.chainId
        ? genesisChain
        : {
            id: MAINNET.chainId,
            name: "Robinhood Chain",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
          },
    transport: http(chainId === TESTNET.chainId ? TESTNET.rpc : "https://rpc.mainnet.chain.robinhood.com"),
  });

  const w = wallet.toLowerCase();
  const out: ProfileNftOption[] = [];

  for (const item of items) {
    const contract = item.token?.address_hash as Address | undefined;
    const tokenId = Number(item.id);
    if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract) || !tokenId) continue;

    try {
      const owner = await client.readContract({
        address: contract,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      });
      if (owner.toLowerCase() !== w) continue;
    } catch {
      continue;
    }

    const collectionName = item.token?.name?.trim() || `${contract.slice(0, 6)}…${contract.slice(-4)}`;
    const label = item.metadata?.name?.trim() || `${collectionName} #${tokenId}`;
    let imageUrl = NFT_PLACEHOLDER_IMAGE;
    if (item.image_url && (item.image_url.startsWith("http") || item.image_url.startsWith("data:"))) {
      imageUrl = normalizeImageUrl(item.image_url);
    } else {
      try {
        const uri = await client.readContract({
          address: contract,
          abi: erc721Abi,
          functionName: "tokenURI",
          args: [BigInt(tokenId)],
        });
        const meta = uri ? await resolveTokenUriMetadata(uri) : null;
        if (meta?.image) imageUrl = meta.image;
      } catch {
        /* placeholder */
      }
    }

    out.push(
      classifyProfileNft({
        chainId,
        contract,
        tokenId,
        collectionName,
        label,
        imageUrl,
      })
    );
  }

  return out;
}
