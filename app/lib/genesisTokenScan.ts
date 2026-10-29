import { createPublicClient, http, parseAbi, type Address } from "viem";
import { genesisChain } from "./genesisMarket";
import { TESTNET } from "./testnet";

/** Max token id to scan when supply hints are missing (non-enumerable ERC-721). */
export const GENESIS_SCAN_CAP = 64;

export const GENESIS_SCAN_TIMEOUT_MS = 6000;

const ZERO = "0x0000000000000000000000000000000000000000";

const publicClient = createPublicClient({
  chain: genesisChain,
  transport: http(TESTNET.rpc, { timeout: GENESIS_SCAN_TIMEOUT_MS }),
});

const nftScanAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

const stakingScanAbi = parseAbi(["function stakerOf(uint256 id) view returns (address)"]);

export class GenesisScanError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, timedOut = false) {
    super(message);
    this.name = "GenesisScanError";
    this.timedOut = timedOut;
  }
}

export function withGenesisScanTimeout<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new GenesisScanError(
          `Genesis token scan timed out after ${GENESIS_SCAN_TIMEOUT_MS / 1000}s. Check testnet RPC and retry.`,
          true
        )
      );
    }, GENESIS_SCAN_TIMEOUT_MS);
    run()
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e instanceof GenesisScanError ? e : new GenesisScanError(e instanceof Error ? e.message : "Scan failed"));
      });
  });
}

export function normalizeAddr(a: string): string {
  return a.toLowerCase();
}

export function walletOwnsOrStakes(
  wallet: Address,
  owner: Address,
  staker: Address
): { owned: boolean; stakedByWallet: boolean } {
  const w = normalizeAddr(wallet);
  const owned = normalizeAddr(owner) === w;
  const stakedByWallet =
    normalizeAddr(staker) === w && normalizeAddr(staker) !== normalizeAddr(ZERO);
  return { owned, stakedByWallet };
}

/** How many token ids to scan (1..limit inclusive). */
export async function getGenesisScanLimit(): Promise<number> {
  let hint = 0;
  for (const fn of ["totalSupply", "totalMinted"] as const) {
    try {
      const v = await publicClient.readContract({
        address: TESTNET.genesisNodeNft,
        abi: nftScanAbi,
        functionName: fn,
      });
      const n = Number(v);
      if (n > hint) hint = n;
    } catch {
      /* try next */
    }
  }
  if (hint > 0) return Math.min(hint, GENESIS_SCAN_CAP);
  return GENESIS_SCAN_CAP;
}

export type GenesisScanMatrix = {
  limit: number;
  /** tokenId -> owner, only minted ids */
  owners: Map<number, Address>;
  /** tokenId -> staker (zero address if none) */
  stakers: Map<number, Address>;
};

/** One Multicall3 round-trip: ownerOf(1..limit) + stakerOf(1..limit) via public testnet RPC. */
export async function fetchGenesisScanMatrix(limit: number): Promise<GenesisScanMatrix> {
  const contracts: {
    address: Address;
    abi: typeof nftScanAbi | typeof stakingScanAbi;
    functionName: "ownerOf" | "stakerOf";
    args: readonly [bigint];
  }[] = [];
  for (let id = 1; id <= limit; id++) {
    contracts.push({
      address: TESTNET.genesisNodeNft,
      abi: nftScanAbi,
      functionName: "ownerOf",
      args: [BigInt(id)],
    });
    contracts.push({
      address: TESTNET.nodeBondStaking,
      abi: stakingScanAbi,
      functionName: "stakerOf",
      args: [BigInt(id)],
    });
  }

  const results = await publicClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: TESTNET.multicall3,
  });

  const owners = new Map<number, Address>();
  const stakers = new Map<number, Address>();

  for (let id = 1; id <= limit; id++) {
    const ownerIx = (id - 1) * 2;
    const stakerIx = ownerIx + 1;
    const ownerRes = results[ownerIx];
    const stakerRes = results[stakerIx];
    if (ownerRes?.status === "success") {
      owners.set(id, ownerRes.result);
    }
    if (stakerRes?.status === "success") {
      stakers.set(id, stakerRes.result);
    } else {
      stakers.set(id, ZERO as Address);
    }
  }

  return { limit, owners, stakers };
}

export async function safeOwnerOf(tokenId: number): Promise<Address | null> {
  try {
    return await publicClient.readContract({
      address: TESTNET.genesisNodeNft,
      abi: nftScanAbi,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    });
  } catch {
    return null;
  }
}

export async function safeStakerOf(tokenId: number): Promise<Address> {
  try {
    return await publicClient.readContract({
      address: TESTNET.nodeBondStaking,
      abi: stakingScanAbi,
      functionName: "stakerOf",
      args: [BigInt(tokenId)],
    });
  } catch {
    return ZERO as Address;
  }
}

/**
 * Returns token ids minted in 1..scanLimit (ownerOf succeeds).
 * Does not use ERC721Enumerable.
 */
export async function listMintedGenesisTokenIds(scanLimit?: number): Promise<number[]> {
  return withGenesisScanTimeout(async () => {
    const limit = scanLimit ?? (await getGenesisScanLimit());
    const matrix = await fetchGenesisScanMatrix(limit);
    return [...matrix.owners.keys()].sort((a, b) => a - b);
  });
}

/** Token ids the wallet owns (ownerOf) or has staked (stakerOf), without enumeration. */
export async function findWalletGenesisTokenIds(wallet: Address): Promise<number[]> {
  return withGenesisScanTimeout(async () => {
    const limit = await getGenesisScanLimit();
    const matrix = await fetchGenesisScanMatrix(limit);
    const found = new Set<number>();

    for (const [id, owner] of matrix.owners) {
      const staker = matrix.stakers.get(id) ?? (ZERO as Address);
      const { owned, stakedByWallet } = walletOwnsOrStakes(wallet, owner, staker);
      if (owned || stakedByWallet) found.add(id);
    }

    for (const [id, staker] of matrix.stakers) {
      if (!matrix.owners.has(id)) {
        const { stakedByWallet } = walletOwnsOrStakes(wallet, ZERO as Address, staker);
        if (stakedByWallet) found.add(id);
      }
    }

    return [...found].sort((a, b) => a - b);
  });
}
