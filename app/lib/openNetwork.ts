/**
 * The open agent network (testnet): any ERC-8004 agent from any chain bonds mDLPH to run nodes or validate
 * (delphi-genesis-node src/open: ValidatorSet, OpenAgentBond, NodePointsV3, RewardPoolV3). Client-safe config + reads.
 * Addresses come from env once deployed; until then the hub explains what's coming and nothing else changes.
 */
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { genesisChain } from "./genesisMarket";
import { TESTNET } from "./testnet";

const a = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);
export const OPEN = {
  bond: a(process.env.NEXT_PUBLIC_OPEN_AGENT_BOND),
  validators: a(process.env.NEXT_PUBLIC_OPEN_VALIDATORS),
  token: a(process.env.NEXT_PUBLIC_OPEN_TOKEN),
  idBase: 1_000_000,
  nodeBond: 10_000,
  validatorBond: 100_000,
  holderShare: 20,
};
export const openLive = !!OPEN.bond;
export const isAgentId = (id: number) => id > OPEN.idBase;
/** Genesis card (1..2500) or, once the open network is live, a bonded agent (1,000,001+) */
export function validNodeId(raw: string | number): number | null {
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) return null;
  if (n <= 2500) return n;
  return openLive && n > OPEN.idBase && n < OPEN.idBase * 2 ? n : null;
}

export const ROLE = { 1: "Node", 2: "Validator" } as const;
export const STATE = { 0: "Left", 1: "Active", 2: "Leaving", 3: "Being slashed", 4: "Underbonded" } as const;

/** partner collections (agents bound to one of their NFTs earn a boost); mirrors OpenAgentBond.setPartner */
export const PARTNERS = [
  { name: "MUSEGOD", chainId: 4663, collection: "0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836" as Address, boostBps: 1000 },
  { name: "Normies", chainId: 1, collection: "0x9Eb6E2025B64f340691e424b7fe7022fFDE12438" as Address, boostBps: 1000 },
];

/** chains whose ERC-8004 agents can join; identity registry = the canonical ERC-8004 deployment on that chain */
export const AGENT_CHAINS: { chainId: number; name: string; rpc: string; registry: Address }[] = [
  { chainId: 1, name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  { chainId: 8453, name: "Base", rpc: "https://base-rpc.publicnode.com", registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  { chainId: 42161, name: "Arbitrum", rpc: "https://arbitrum-one-rpc.publicnode.com", registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  { chainId: 10, name: "Optimism", rpc: "https://optimism-rpc.publicnode.com", registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  { chainId: 4663, name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  { chainId: 46630, name: "Robinhood testnet", rpc: TESTNET.rpc, registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" },
];
export const chainName = (id: number) => AGENT_CHAINS.find((c) => c.chainId === id)?.name ?? `chain ${id}`;

/** what the agent's owner signs to let `operator` run it in the Delphi network */
export function joinProofMessage(chainId: number, registry: string, agentId: string | bigint, operator: string, role: number): string {
  return `delphi-open-join:v1:${chainId}:${registry.toLowerCase()}:${agentId}:${operator.toLowerCase()}:${role}\n\nI control this ERC-8004 agent and let ${operator} run it in the Delphi network as a ${role === 2 ? "validator" : "node"}.`;
}

export const openBondAbi = parseAbi([
  "function agents(uint256) view returns (address operator, uint8 role, uint8 state, uint16 boostBps, uint64 since, uint64 unlockAt, uint128 bond, uint64 chainId, address registry, uint256 agentId)",
  "function nodes(uint256) view returns (address, uint8, uint64, uint64, uint64, bool, bytes32)",
  "function count() view returns (uint256)",
  "function nodeBond() view returns (uint256)",
  "function validatorBond() view returns (uint256)",
  "function bondFor(uint8) view returns (uint256)",
  "function token() view returns (address)",
  "function join(uint8 role, uint64 chainId, address registry, uint256 agentId, uint64 pChain, address pColl, uint64 expiry, bytes[] sigs) returns (uint256)",
  "function leave(uint256 id)",
  "function withdraw(uint256 id)",
  "function topUp(uint256 id, uint256 amount)",
]);
export const validatorSetAbi = parseAbi(["function threshold() view returns (uint8)", "function coreCount() view returns (uint256)"]);
export const testTokenAbi = parseAbi([
  "function mint(address to, uint256 v)",
  "function approve(address s, uint256 v) returns (bool)",
  "function allowance(address o, address s) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
export const JOINED = parseAbiItem("event Joined(uint256 indexed id, address indexed operator, uint8 role, uint64 chainId, address registry, uint256 agentId, uint16 boostBps, uint256 bond)");

export const testnetClient = createPublicClient({ chain: genesisChain, transport: http(TESTNET.rpc) });

export type OpenAgent = {
  id: number; operator: Address; role: number; state: number; boostBps: number; since: number; unlockAt: number;
  bond: string; chainId: number; registry: Address; agentId: string;
};

export async function readAgent(id: number): Promise<OpenAgent | null> {
  if (!OPEN.bond || !isAgentId(id)) return null;
  const r = await testnetClient.readContract({ address: OPEN.bond, abi: openBondAbi, functionName: "agents", args: [BigInt(id)] });
  const [operator, role, state, boostBps, since, unlockAt, bond, chainId, registry, agentId] = r;
  if (operator === "0x0000000000000000000000000000000000000000") return null;
  return { id, operator, role, state, boostBps, since: Number(since), unlockAt: Number(unlockAt), bond: bond.toString(), chainId: Number(chainId), registry, agentId: agentId.toString() };
}

/** every agent that ever joined (current state read fresh) */
export async function listAgents(): Promise<OpenAgent[]> {
  if (!OPEN.bond) return [];
  const n = Number(await testnetClient.readContract({ address: OPEN.bond, abi: openBondAbi, functionName: "count" }));
  const ids = Array.from({ length: Math.min(n, 500) }, (_, i) => OPEN.idBase + 1 + i);
  return (await Promise.all(ids.map((id) => readAgent(id).catch(() => null)))).filter((x): x is OpenAgent => !!x);
}
