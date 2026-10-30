/**
 * Validator re-check for the open network: the TypeScript twin of delphi-genesis-node script/cosigner.py, used by the
 * desktop app's Validator mode. Given a point-credit batch another validator proposed (/api/open/cosign/pending), it
 * re-checks ALL the evidence and only then is the batch digest signed:
 *   1. the batch isn't credited yet and its digest matches the points contract's batchDigest,
 *   2. every row is valid like the attestor checks it: node signature (or an approved session key), the wallet stakes
 *      the card (or operates the agent) and it's active, the anchor block is real and fresh, the epoch isn't locked,
 *   3. every row's work is recomputed (Freivalds result hash from its on-chain seed): no sampling,
 *   4. no card asks for more than its verified uptime allows (attestor.uptime_credits),
 *   5. the batch id is exactly the hash of the rows it carries, and no row was signed before in another batch.
 * Constants and formats must stay identical to script/attestor.py.
 */
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, recoverMessageAddress, toBytes, type Address, type Hex } from "viem";
import { genesisChain } from "./genesisMarket";
import { OPEN } from "./openNetwork";
import { PEG_LIVE, TESTNET } from "./testnet";
import { buildMatrices } from "../node/freivaldsCore";

export const ID_BASE = 1_000_000;
const CHAIN_ID = 46630;
const EPOCH_DAYS = 7, GRACE_DAYS = 1;
const ANCHOR_SLACK = 900;
const TILES = new Set([512, 1024]);
const EXPECTED_V1 = new Set(["a721e982", "9af5d03f"]);
const CHECKS_PER_SEC = 150;
const DAY_CAP = 23_000;
const CREDIT_PER_SEC = DAY_CAP / (24 * 3600);
const FIRST_ROW_MAX_SEC = 15 * 60;
const SESSION_MAX_SEC = 7 * 86400;

const client = createPublicClient({ chain: genesisChain, transport: http(TESTNET.rpc) });
const ptsAbi = parseAbi([
  "function batchDigest(uint256 batchId, uint32 day, uint256[] ids, uint256[] checks) view returns (bytes32)",
  "function batchUsed(uint256) view returns (bool)",
]);
const stakingAbi = parseAbi(["function stakerOf(uint256) view returns (address)", "function isActive(uint256) view returns (bool)"]);
const bondAbi = parseAbi(["function nodes(uint256) view returns (address, uint8, uint64, uint64, uint64, bool, bytes32)"]);
const mirrorAbi = parseAbi(["function isStale(uint256) view returns (bool)"]);

export type Proposal = {
  batchId: string; day: number; ids: number[]; checks: number[]; digest: Hex; proposer: string;
  rows: Record<string, Record<string, unknown>[]>;
  prevTs: Record<string, number | null>;
};
type Row = {
  tokenId: number; wallet: string; resultHash: string; checks: number; durationSec: number; ts: number; sig: Hex;
  anchorBlock: number | null; n: number | null; sessionKey: string | null; sessionExpires: number | null; sessionSig: Hex | null;
  anchorTs?: number; seed?: number;
};
export type RowKey = [number, number, string];

/** what this validator signed before (persisted by the caller): row keys -> batch, and each card's latest signed ts */
export type Ledger = {
  batchOf(key: RowKey): string | undefined;
  maxTs(tokenId: number, exceptBatch: string): number | null;
};

const intOf = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error("not an integer"); return n; };

function parseRow(x: Record<string, unknown>): Row {
  return {
    tokenId: intOf(x.tokenId), wallet: String(x.wallet), resultHash: String(x.resultHash), checks: intOf(x.checks),
    durationSec: intOf(x.durationSec), ts: intOf(x.ts), sig: String(x.sig) as Hex,
    anchorBlock: x.anchorBlock != null ? intOf(x.anchorBlock) : null, n: x.n != null ? intOf(x.n) : null,
    sessionKey: x.sessionKey ? String(x.sessionKey) : null,
    sessionExpires: x.sessionExpires != null ? intOf(x.sessionExpires) : null,
    sessionSig: x.sessionSig ? (String(x.sessionSig) as Hex) : null,
  };
}
const msgFor = (r: Row) =>
  r.anchorBlock != null
    ? `delphi-node:v2:${CHAIN_ID}:${r.tokenId}:${r.resultHash}:${r.checks}:${r.durationSec}:${r.ts}:${r.anchorBlock}:${r.n}`
    : `delphi-node:v1:${CHAIN_ID}:${r.tokenId}:${r.resultHash}:${r.checks}:${r.durationSec}:${r.ts}`;
const sessionMsg = (id: number, key: string, exp: number) => `delphi-node-session:v1:${CHAIN_ID}:${id}:${key.toLowerCase()}:${exp}`;

const blocks = new Map<number, { hash: Hex; ts: number }>();
async function blockAt(n: number) {
  const hit = blocks.get(n); if (hit) return hit;
  const b = await client.getBlock({ blockNumber: BigInt(n) });
  if (!b?.hash) throw new Error(`no block ${n}`);
  const v = { hash: b.hash, ts: Number(b.timestamp) }; blocks.set(n, v); return v;
}
function challengeSeed(blockHash: Hex, tokenId: number, wallet: string): number {
  const h = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [blockHash, BigInt(tokenId), wallet as Address]));
  return Number(BigInt(`0x${h.slice(2, 10)}`)) >>> 0;
}
async function stakerOf(id: number): Promise<string> {
  if (id > ID_BASE) { if (!OPEN.bond) return "0x0000000000000000000000000000000000000000"; return (await client.readContract({ address: OPEN.bond, abi: bondAbi, functionName: "nodes", args: [BigInt(id)] }))[0]; }
  return client.readContract({ address: TESTNET.nodeBondStaking, abi: stakingAbi, functionName: "stakerOf", args: [BigInt(id)] });
}
async function isActive(id: number): Promise<boolean> {
  if (id > ID_BASE) { if (!OPEN.bond) return false; return (await client.readContract({ address: OPEN.bond, abi: bondAbi, functionName: "nodes", args: [BigInt(id)] }))[1] === 1; }
  return client.readContract({ address: TESTNET.nodeBondStaking, abi: stakingAbi, functionName: "isActive", args: [BigInt(id)] });
}

/** attestor.validate: [row, null] when valid, else [row|null, reason] */
async function validate(raw: Record<string, unknown>, today: number): Promise<[Row | null, string | null]> {
  let r: Row;
  try { r = parseRow(raw); } catch (e) { return [null, `malformed: ${e instanceof Error ? e.message : e}`]; }
  if (r.checks <= 0 || r.durationSec <= 0) return [r, "non-positive checks/duration"];
  if (r.ts > Date.now() / 1000 + 300) return [r, "ts in future"];
  if (r.ts > 1e11) return [r, "ts must be unix seconds"];
  const rd = Math.floor(r.ts / 86400);
  if (rd < today && today > (Math.floor(rd / EPOCH_DAYS) + 1) * EPOCH_DAYS + GRACE_DAYS - 1) return [r, "late: epoch locked"];
  if (r.anchorBlock != null) {
    if (r.n == null || !TILES.has(r.n)) return [r, `bad tile ${r.n}`];
    let b; try { b = await blockAt(r.anchorBlock); } catch (e) { return [r, `bad anchor: ${e instanceof Error ? e.message : e}`]; }
    if (b.ts > r.ts || b.ts < r.ts - r.durationSec - ANCHOR_SLACK) return [r, "stale or future anchor block"];
    r.seed = challengeSeed(b.hash, r.tokenId, r.wallet); r.anchorTs = b.ts;
  } else if (!EXPECTED_V1.has(r.resultHash.toLowerCase())) return [r, `bad resultHash ${r.resultHash}`];
  let signer: string;
  try { signer = await recoverMessageAddress({ message: msgFor(r), signature: r.sig }); } catch (e) { return [r, `bad sig: ${e instanceof Error ? e.message : e}`]; }
  if (r.sessionKey) {
    if (r.sessionExpires == null || !r.sessionSig) return [r, "incomplete session"];
    if (r.ts > r.sessionExpires) return [r, "session expired"];
    if (r.sessionExpires - r.ts > SESSION_MAX_SEC) return [r, "session too long"];
    if (signer.toLowerCase() !== r.sessionKey.toLowerCase()) return [r, "sig != session key"];
    try { signer = await recoverMessageAddress({ message: sessionMsg(r.tokenId, r.sessionKey, r.sessionExpires), signature: r.sessionSig }); }
    catch (e) { return [r, `bad session sig: ${e instanceof Error ? e.message : e}`]; }
  }
  if (signer.toLowerCase() !== r.wallet.toLowerCase()) return [r, "sig != wallet"];
  if (!(await isActive(r.tokenId))) return [r, "node not active"];
  if ((await stakerOf(r.tokenId)).toLowerCase() !== signer.toLowerCase()) return [r, "wallet is not staker"];
  return [r, null];
}

/** attestor.uptime_credits: [row, credited] in ts order */
export function uptimeCredits(rows: Row[], prevTs: number | null): [Row, number][] {
  const out: [Row, number][] = [];
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    let secs = r.durationSec;
    secs = r.anchorTs != null ? Math.min(secs, Math.max(0, r.ts - r.anchorTs)) : Math.min(secs, FIRST_ROW_MAX_SEC);
    if (prevTs != null) secs = Math.min(secs, Math.max(0, r.ts - prevTs));
    prevTs = prevTs == null ? r.ts : Math.max(prevTs, r.ts);
    out.push([r, Math.min(r.checks, r.durationSec * CHECKS_PER_SEC, Math.floor(secs * CREDIT_PER_SEC))]);
  }
  return out;
}

/** Python's json.dumps(sorted(keys)) for [(int, int, str)] tuples, byte for byte */
export function pyJsonKeys(keys: RowKey[]): string {
  return "[" + keys.map(([a, b, c]) => `[${a}, ${b}, ${JSON.stringify(c)}]`).join(", ") + "]";
}
export function batchIdFor(points: string, keys: RowKey[]): bigint {
  const sorted = [...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  return BigInt(keccak256(toBytes(`delphi-attestor:v2:${points.toLowerCase()}:${pyJsonKeys(sorted)}`)));
}

/** cosigner.check: null when the batch checks out, else why to refuse. `recompute` does the Freivalds work (slow). */
export async function checkProposal(
  p: Proposal,
  ledger: Ledger,
  recompute: (seed: number, n: number) => Promise<string> = async (seed, n) => buildMatrices(seed, n, false).resultHash,
): Promise<{ reason: string | null; keys: RowKey[] }> {
  const b = BigInt(p.batchId), d = Number(p.day), ids = p.ids.map(Number), ch = p.checks.map(Number);
  const keys: RowKey[] = [];
  if (ids.length !== ch.length || new Set(ids).size !== ids.length) return { reason: "bad ids/checks", keys };
  if (await client.readContract({ address: TESTNET.nodePoints, abi: ptsAbi, functionName: "batchUsed", args: [b] })) return { reason: "already credited", keys };
  const dg = await client.readContract({ address: TESTNET.nodePoints, abi: ptsAbi, functionName: "batchDigest", args: [b, d, ids.map(BigInt), ch.map(BigInt)] });
  if (dg.toLowerCase() !== String(p.digest).toLowerCase()) return { reason: "digest mismatch", keys };
  const today = Math.floor(Date.now() / 86400 / 1000);
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k], need = ch[k];
    const raw = p.rows[String(i)] ?? [];
    if (!raw.length) return { reason: `#${i}: no evidence`, keys };
    if (PEG_LIVE && i < ID_BASE) {
      const stale = await client.readContract({ address: TESTNET.nodeCards, abi: mirrorAbi, functionName: "isStale", args: [BigInt(i)] }).catch(() => false);
      if (stale) return { reason: `#${i}: card sold on mainnet while staked`, keys };
    }
    const rows: Row[] = [];
    for (const x of raw) {
      const [r, err] = await validate(x, today);
      if (!r || err) return { reason: `#${i}: row ts=${String(x.ts)}: ${err ?? "malformed"}`, keys };
      if (r.seed != null && r.n != null && (await recompute(r.seed, r.n)).toLowerCase() !== r.resultHash.toLowerCase())
        return { reason: `#${i}: row ts=${r.ts}: result hash doesn't match its seed (work not done)`, keys };
      if (r.tokenId !== i) return { reason: `#${i}: row for another card`, keys };
      const key: RowKey = [r.tokenId, r.ts, r.resultHash.toLowerCase()];
      const prev = ledger.batchOf(key);
      if (prev && prev !== String(b)) return { reason: `#${i}: row ts=${r.ts} already signed in another batch`, keys };
      rows.push(r); keys.push(key);
    }
    const mine = ledger.maxTs(i, String(b));
    const theirs = p.prevTs?.[String(i)] ?? null;
    const prevTs = theirs == null && mine == null ? null : Math.max(theirs ?? -Infinity, mine ?? -Infinity);
    const allowed = uptimeCredits(rows, prevTs).filter(([r]) => Math.floor(r.ts / 86400) === d).reduce((a, [, c]) => a + c, 0);
    if (need > allowed) return { reason: `#${i}: asks ${need} points, evidence supports ${allowed}`, keys };
  }
  if (batchIdFor(TESTNET.nodePoints, keys) !== b) return { reason: "batch id doesn't match its rows", keys };
  return { reason: null, keys };
}
