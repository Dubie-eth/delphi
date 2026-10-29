import { createPublicClient, http, parseAbi, type Address } from "viem";
import { ADAPTERSCAN } from "./adapterscan";
import { genesisChain } from "./genesisMarket";
import {
  fetchGenesisScanMatrix,
  getGenesisScanLimit,
  walletOwnsOrStakes,
  withGenesisScanTimeout,
} from "./genesisTokenScan";
import { fetchWalletNftsFromExplorer } from "./nftExplorerIndex";
import { NFT_PLACEHOLDER_IMAGE, resolveTokenUriMetadata } from "./nftMetadataResolve";
import { MAINNET, TESTNET } from "./testnet";

export const MUSEGOD_MAINNET = "0x13ea3072b7215d4c9c2ec4f498a08c5825129836" as Address;

export const PROFILE_SCAN_TIMEOUT_MS = 18_000;
const OWNER_BATCH = 48;
const SCAN_CAP = 256;

export type ProfilePin = "delphi-agent" | "genesis" | "none";

export type ProfileNftOption = {
  chainId: number;
  contract: Address;
  tokenId: number;
  collectionName: string;
  label: string;
  imageUrl: string;
  /** When set, stake() uses stakeWithMuse(genesisId, museId) — MUSEGOD token ids on mainnet. */
  museId?: number;
  pin: ProfilePin;
  suggested?: boolean;
};

const erc721Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function name() view returns (string)",
]);

const testnetClient = createPublicClient({
  chain: genesisChain,
  transport: http(TESTNET.rpc, { timeout: PROFILE_SCAN_TIMEOUT_MS }),
});

const mainnetChain = {
  id: MAINNET.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ADAPTERSCAN.rpc] } },
} as const;

const mainnetClient = createPublicClient({
  chain: mainnetChain,
  transport: http(ADAPTERSCAN.rpc, { timeout: PROFILE_SCAN_TIMEOUT_MS }),
});

export function clientForChain(chainId: number) {
  if (chainId === TESTNET.chainId) return testnetClient;
  if (chainId === MAINNET.chainId) return mainnetClient;
  throw new Error(`Unsupported chain ${chainId}`);
}

function multicall3(_chainId: number): Address {
  return TESTNET.multicall3;
}

export function isDelphiAgentNft(chainId: number, contract: Address): boolean {
  return chainId === TESTNET.chainId && contract.toLowerCase() === TESTNET.delphi.toLowerCase();
}

export function isGenesisNodeNft(chainId: number, contract: Address): boolean {
  const c = contract.toLowerCase();
  if (chainId === TESTNET.chainId && c === TESTNET.genesisNodeNft.toLowerCase()) return true;
  if (chainId === MAINNET.chainId && c === MAINNET.genesisNodeNft.toLowerCase()) return true;
  return false;
}

export function isMusegodNft(chainId: number, contract: Address): boolean {
  return chainId === MAINNET.chainId && contract.toLowerCase() === MUSEGOD_MAINNET.toLowerCase();
}

export function classifyProfileNft(o: Omit<ProfileNftOption, "pin" | "suggested" | "museId">): ProfileNftOption {
  const pin: ProfilePin = isDelphiAgentNft(o.chainId, o.contract)
    ? "delphi-agent"
    : isGenesisNodeNft(o.chainId, o.contract)
      ? "genesis"
      : "none";
  const suggested = isMusegodNft(o.chainId, o.contract);
  return {
    ...o,
    pin,
    suggested,
    museId: suggested ? o.tokenId : undefined,
  };
}

export function sortProfileOptions(list: ProfileNftOption[]): ProfileNftOption[] {
  const rank = (p: ProfilePin) => (p === "delphi-agent" ? 0 : p === "genesis" ? 1 : 2);
  return [...list].sort((a, b) => {
    const d = rank(a.pin) - rank(b.pin);
    if (d !== 0) return d;
    return a.collectionName.localeCompare(b.collectionName) || a.tokenId - b.tokenId;
  });
}

async function readSupply(chainId: number, contract: Address): Promise<number> {
  const client = clientForChain(chainId);
  try {
    const v = await client.readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "totalSupply",
    });
    const n = Number(v);
    if (n > 0) return Math.min(n, SCAN_CAP);
  } catch {
    /* fall through */
  }
  return SCAN_CAP;
}

async function readCollectionName(chainId: number, contract: Address): Promise<string> {
  const client = clientForChain(chainId);
  try {
    const name = await client.readContract({
      address: contract,
      abi: erc721Abi,
      functionName: "name",
    });
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    /* optional */
  }
  return `${contract.slice(0, 6)}…${contract.slice(-4)}`;
}

async function ownedTokenIdsInRange(
  wallet: Address,
  chainId: number,
  contract: Address,
  limit: number
): Promise<number[]> {
  const client = clientForChain(chainId);
  const owned: number[] = [];
  const w = wallet.toLowerCase();

  for (let start = 1; start <= limit; start += OWNER_BATCH) {
    const end = Math.min(limit, start + OWNER_BATCH - 1);
    const contracts = [];
    for (let id = start; id <= end; id++) {
      contracts.push({
        address: contract,
        abi: erc721Abi,
        functionName: "ownerOf" as const,
        args: [BigInt(id)],
      });
    }
    const results = await client.multicall({
      contracts,
      allowFailure: true,
      multicallAddress: multicall3(chainId),
    });
    for (let i = 0; i < results.length; i++) {
      const id = start + i;
      const r = results[i];
      if (r?.status === "success" && r.result.toLowerCase() === w) owned.push(id);
    }
  }
  return owned;
}

async function enrichWithUri(
  chainId: number,
  contract: Address,
  collectionName: string,
  ids: number[]
): Promise<ProfileNftOption[]> {
  if (ids.length === 0) return [];
  const client = clientForChain(chainId);
  const uriContracts = ids.map((id) => ({
    address: contract,
    abi: erc721Abi,
    functionName: "tokenURI" as const,
    args: [BigInt(id)],
  }));
  const uriResults = await client.multicall({
    contracts: uriContracts,
    allowFailure: true,
    multicallAddress: multicall3(chainId),
  });

  const out: ProfileNftOption[] = [];
  for (let i = 0; i < ids.length; i++) {
    const tokenId = ids[i];
    const uriRes = uriResults[i];
    const uri = uriRes?.status === "success" && typeof uriRes.result === "string" ? uriRes.result : "";
    const meta = uri ? await resolveTokenUriMetadata(uri) : null;
    out.push(
      classifyProfileNft({
        chainId,
        contract,
        tokenId,
        collectionName,
        label: meta?.name ?? `${collectionName} #${tokenId}`,
        imageUrl: meta?.image ?? NFT_PLACEHOLDER_IMAGE,
      })
    );
  }
  return out;
}

export async function scanWalletCollection(
  wallet: Address,
  chainId: number,
  contract: Address,
  collectionNameHint?: string
): Promise<ProfileNftOption[]> {
  const limit = await readSupply(chainId, contract);
  const collectionName = collectionNameHint ?? (await readCollectionName(chainId, contract));
  const ids = await ownedTokenIdsInRange(wallet, chainId, contract, limit);
  return enrichWithUri(chainId, contract, collectionName, ids);
}

export async function scanDelphiAgentProfileOptions(wallet: Address): Promise<ProfileNftOption[]> {
  return scanWalletCollection(wallet, TESTNET.chainId, TESTNET.delphi, "Delphi Agent");
}

export async function scanGenesisProfileOptions(wallet: Address): Promise<ProfileNftOption[]> {
  return withGenesisScanTimeout(async () => {
    const limit = await getGenesisScanLimit();
    const matrix = await fetchGenesisScanMatrix(limit);
    const ids: number[] = [];
    for (const [id, owner] of matrix.owners) {
      const staker = matrix.stakers.get(id) ?? ("0x0000000000000000000000000000000000000000" as Address);
      const { owned, stakedByWallet } = walletOwnsOrStakes(wallet, owner, staker);
      if (owned || stakedByWallet) ids.push(id);
    }
    return enrichWithUri(TESTNET.chainId, TESTNET.genesisNodeNft, "Genesis Node", ids);
  });
}

function dedupeOptions(merged: ProfileNftOption[]): ProfileNftOption[] {
  const seen = new Set<string>();
  const out: ProfileNftOption[] = [];
  for (const n of merged) {
    const k = `${n.chainId}:${n.contract.toLowerCase()}:${n.tokenId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return sortProfileOptions(out);
}

export async function loadAllProfileOptions(
  wallet: Address,
  customCollections: { chainId: number; contract: string; label?: string }[]
): Promise<ProfileNftOption[]> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("Profile NFT scan timed out. Retry or add fewer collections.")),
      PROFILE_SCAN_TIMEOUT_MS
    );
  });

  const run = async () => {
    const tasks: Promise<ProfileNftOption[]>[] = [
      scanDelphiAgentProfileOptions(wallet),
      scanGenesisProfileOptions(wallet),
      scanWalletCollection(wallet, MAINNET.chainId, MUSEGOD_MAINNET, "MUSEGOD"),
      fetchWalletNftsFromExplorer(wallet, TESTNET.chainId).catch(() => []),
      fetchWalletNftsFromExplorer(wallet, MAINNET.chainId).catch(() => []),
    ];
    for (const c of customCollections) {
      const addr = c.contract as Address;
      tasks.push(scanWalletCollection(wallet, c.chainId, addr, c.label));
    }
    const chunks = await Promise.all(tasks);
    return dedupeOptions(chunks.flat());
  };

  return Promise.race([run(), timeout]);
}
