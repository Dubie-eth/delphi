import { STATE, chainName, listAgents, openLive } from "./openNetwork";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { genesisChain, parseTokenUriJson, staticFallbackImage } from "./genesisMarket";
import {
  fetchGenesisScanMatrix,
  getGenesisScanLimit,
  walletOwnsOrStakes,
  withGenesisScanTimeout,
} from "./genesisTokenScan";
import { PEG_LIVE, TESTNET } from "./testnet";

const publicClient = createPublicClient({
  chain: genesisChain,
  transport: http(TESTNET.rpc),
});

export const nodeStakingAbi = parseAbi([
  "function stakerOf(uint256 id) view returns (address)",
  "function isActive(uint256 id) view returns (bool)",
  "function nodes(uint256 id) view returns (address staker, uint8 state, uint64 since, uint64 unlockAt, uint64 slashAt, bool appealed, bytes32 evidence)",
  "function stake(uint256 id)",
  "function stakeWithMuse(uint256 id, uint256 museId)",
  "function museUsedBy(uint256 museId) view returns (uint256)",
]);

export const nodePointsAbi = parseAbi([
  "function checksOnDay(uint256 id, uint32 day) view returns (uint256)",
  "function activeDays(uint256 id) view returns (uint32)",
  "function lastActive(uint256 id) view returns (uint64)",
  "function points(address account) view returns (uint256)",
  "function POINTS_PER_CHECK() view returns (uint256)",
  "function season() view returns (uint256)",
  "function seasonRoot(uint256 n) view returns (bytes32)",
  "function epochLocked(uint256 epoch) view returns (bool)",
]);

export const rewardPoolAbi = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function claimable(uint256 epoch, address account) view returns (uint256)",
  "function claimMany(uint256[] epochs)",
]);

export const genesisNftBondAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved)",
]);

export type WalletBondToken = {
  tokenId: number;
  owned: boolean;
  stakedByWallet: boolean;
  isActive: boolean;
  name: string;
  image: string;
  tier: string;
  status: string;
};

export type TokenPointsView = {
  checksToday: bigint;
  totalPoints: bigint;
  activeDays: number;
  lastActiveSec: number;
  season: number;
};

export type ClaimableEpoch = {
  epoch: number;
  amount: bigint;
};

export function unixDayIndex(): number {
  return Math.floor(Date.now() / 1000 / 86400);
}

export function formatCreditDay(day: number): string {
  if (!day) return "Never";
  return new Date(day * 86400000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Genesis cards the wallet holds or stakes, plus (open network) agents it operates */
export async function listWalletBondTokens(wallet: Address): Promise<WalletBondToken[]> {
  const [cards, agents] = await Promise.all([listWalletGenesisBondTokens(wallet), listWalletAgents(wallet).catch(() => [])]);
  return [...cards, ...agents];
}

async function listWalletAgents(wallet: Address): Promise<WalletBondToken[]> {
  if (!openLive) return [];
  const mine = (await listAgents()).filter((a) => a.operator.toLowerCase() === wallet.toLowerCase() && a.role === 1 && a.state !== 0);
  return mine.map((a) => ({
    tokenId: a.id,
    owned: false,
    stakedByWallet: true,
    isActive: a.state === 1,
    name: `Agent ${a.id} (${chainName(a.chainId)} #${a.agentId})`,
    image: "/delphi-logo.png",
    tier: "Open network node",
    status: STATE[a.state as keyof typeof STATE] ?? "",
  }));
}

async function listWalletGenesisBondTokens(wallet: Address): Promise<WalletBondToken[]> {
  return withGenesisScanTimeout(async () => {
    const limit = await getGenesisScanLimit(TESTNET.nodeCards);
    const matrix = await fetchGenesisScanMatrix(limit, TESTNET.nodeCards);
    const staking = TESTNET.nodeBondStaking;
    const matched: { id: number; owned: boolean; stakedByWallet: boolean }[] = [];

    for (const [id, owner] of matrix.owners) {
      const staker = matrix.stakers.get(id) ?? ("0x0000000000000000000000000000000000000000" as Address);
      const { owned, stakedByWallet } = walletOwnsOrStakes(wallet, owner, staker);
      if (owned || stakedByWallet) matched.push({ id, owned, stakedByWallet });
    }

    if (matched.length === 0) return [];

    const metaContracts = matched.flatMap(({ id }) => [
      {
        address: staking,
        abi: nodeStakingAbi,
        functionName: "isActive" as const,
        args: [BigInt(id)],
      },
      {
        address: TESTNET.nodeCards,
        abi: genesisNftBondAbi,
        functionName: "tokenURI" as const,
        args: [BigInt(id)],
      },
    ]);

    const metaResults = await publicClient.multicall({
      contracts: metaContracts,
      allowFailure: true,
      multicallAddress: TESTNET.multicall3,
    });

    const tokens: WalletBondToken[] = [];
    for (let i = 0; i < matched.length; i++) {
      const { id, owned, stakedByWallet } = matched[i];
      const activeRes = metaResults[i * 2];
      const uriRes = metaResults[i * 2 + 1];
      const active = activeRes?.status === "success" ? Boolean(activeRes.result) : false;
      const uri = uriRes?.status === "success" && typeof uriRes.result === "string" ? uriRes.result : "";
      const meta = uri ? parseTokenUriJson(uri) : null;
      tokens.push({
        tokenId: id,
        owned,
        stakedByWallet,
        isActive: active,
        name: meta?.name ?? `Genesis Node #${id}`,
        // with the peg, node #N is mainnet card #N: show that card's PFP (the mirror has no tokenURI)
        image: meta?.image ?? (PEG_LIVE ? `/card/${id}/pfp` : staticFallbackImage(id) ?? "/genesis/live-1.png"),
        tier: meta?.tier ?? "—",
        status: meta?.status ?? "—",
      });
    }

    return tokens.sort((a, b) => a.tokenId - b.tokenId);
  });
}

export async function fetchTokenPointsView(
  tokenId: number,
  wallet: Address
): Promise<TokenPointsView> {
  const day = unixDayIndex();
  const pointsAddr = TESTNET.nodePoints;
  const [checksToday, activeDays, lastActiveSec, totalPoints, season] = await Promise.all([
    publicClient.readContract({
      address: pointsAddr,
      abi: nodePointsAbi,
      functionName: "checksOnDay",
      args: [BigInt(tokenId), day],
    }),
    publicClient.readContract({
      address: pointsAddr,
      abi: nodePointsAbi,
      functionName: "activeDays",
      args: [BigInt(tokenId)],
    }),
    publicClient.readContract({
      address: pointsAddr,
      abi: nodePointsAbi,
      functionName: "lastActive",
      args: [BigInt(tokenId)],
    }),
    publicClient.readContract({
      address: pointsAddr,
      abi: nodePointsAbi,
      functionName: "points",
      args: [wallet],
    }),
    publicClient.readContract({
      address: pointsAddr,
      abi: nodePointsAbi,
      functionName: "season",
    }),
  ]);

  return {
    checksToday,
    totalPoints,
    activeDays: Number(activeDays),
    lastActiveSec: Number(lastActiveSec),
    season: Number(season),
  };
}

export async function fetchClaimableRewardEpochs(
  wallet: Address,
  maxLookback = 16
): Promise<ClaimableEpoch[]> {
  const current = await publicClient.readContract({
    address: TESTNET.rewardPool,
    abi: rewardPoolAbi,
    functionName: "currentEpoch",
  });
  const cur = Number(current);
  const out: ClaimableEpoch[] = [];
  for (let e = Math.max(0, cur - maxLookback); e < cur; e++) {
    const locked = await publicClient.readContract({
      address: TESTNET.nodePoints,
      abi: nodePointsAbi,
      functionName: "epochLocked",
      args: [BigInt(e)],
    });
    if (!locked) continue;
    const amount = await publicClient.readContract({
      address: TESTNET.rewardPool,
      abi: rewardPoolAbi,
      functionName: "claimable",
      args: [BigInt(e), wallet],
    });
    if (amount > BigInt(0)) out.push({ epoch: e, amount });
  }
  return out;
}

/** Read-only via public testnet RPC (not the wallet provider). */
export async function isNftApprovedForStaking(wallet: Address, tokenId: number): Promise<boolean> {
  const staking = TESTNET.nodeBondStaking;
  const [approvedForAll, tokenOperator] = await Promise.all([
    publicClient.readContract({
      address: TESTNET.nodeCards,
      abi: genesisNftBondAbi,
      functionName: "isApprovedForAll",
      args: [wallet, staking],
    }),
    publicClient.readContract({
      address: TESTNET.nodeCards,
      abi: genesisNftBondAbi,
      functionName: "getApproved",
      args: [BigInt(tokenId)],
    }),
  ]);
  if (approvedForAll) return true;
  return tokenOperator.toLowerCase() === staking.toLowerCase();
}

/** Skips `setApprovalForAll` when already approved on-chain; throws with wallet error if approve fails. */
export async function ensureStakingApproval(
  wallet: Address,
  tokenId: number,
  writeApproval: () => Promise<`0x${string}`>
): Promise<void> {
  if (await isNftApprovedForStaking(wallet, tokenId)) return;
  const hash = await writeApproval();
  await publicClient.waitForTransactionReceipt({ hash });
  if (!(await isNftApprovedForStaking(wallet, tokenId))) {
    throw new Error("Approval tx mined but staking contract still not approved for this NFT.");
  }
}

export function buildNodeSignMessage(params: {
  tokenId: number;
  resultHash: string;
  checks: number;
  durationSec: number;
  ts: number;
  anchorBlock: number;
  n: number;
}): string {
  return `delphi-node:v2:46630:${params.tokenId}:${params.resultHash}:${params.checks}:${params.durationSec}:${params.ts}:${params.anchorBlock}:${params.n}`;
}
