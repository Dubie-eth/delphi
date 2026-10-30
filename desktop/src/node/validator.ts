/**
 * Validator mode: this computer re-checks the point-credit batches other validators propose and co-signs the ones
 * that hold up (the TypeScript twin of script/cosigner.py, shared in @delphi/lib/validatorCheck). Its own validator
 * key is made here and never leaves this computer; the owner's wallet registers it once at delphi.site/network
 * (Genesis holders: one staked card + 50,000 mDLPH). Rewards go to the owner's wallet, never to this key.
 * It never sends transactions: the proposer submits once the quorum signed.
 */
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkProposal, type Ledger, type Proposal, type RowKey } from "@delphi/lib/validatorCheck";
import { OPEN } from "@delphi/lib/openNetwork";
import { TESTNET } from "@delphi/lib/testnet";
import { genesisChain } from "@delphi/lib/genesisMarket";
import { SITE_ORIGIN } from "../config";

const KEY = "delphi-desktop-validator-key";
const LEDGER = "delphi-desktop-validator-ledger";
const KEEP_SEC = 14 * 86400;

export function validatorKey(): Hex {
  let k = localStorage.getItem(KEY) as Hex | null;
  if (!k) { k = generatePrivateKey(); localStorage.setItem(KEY, k); }
  return k;
}
export const validatorAddress = (): Address => privateKeyToAccount(validatorKey()).address;
export const registerUrl = () => `${SITE_ORIGIN}/network?validator=${validatorAddress()}#validate`;

type Stored = { rows: Record<string, { b: string; ts: number }>; decided: Record<string, { ok: boolean; why: string; at: number }> };
function load(): Stored {
  try { const s = JSON.parse(localStorage.getItem(LEDGER) || "null"); if (s && s.rows && s.decided) return s; } catch { /* fresh */ }
  return { rows: {}, decided: {} };
}
function save(s: Stored) {
  const cut = Date.now() / 1000 - KEEP_SEC;
  for (const [k, v] of Object.entries(s.rows)) if (v.ts < cut) delete s.rows[k];
  for (const [k, v] of Object.entries(s.decided)) if (v.at < cut) delete s.decided[k];
  try { localStorage.setItem(LEDGER, JSON.stringify(s)); } catch { /* full: next run re-checks */ }
}
const keyStr = (k: RowKey) => `${k[0]}:${k[1]}:${k[2]}`;

/** Freivalds recompute in a worker (a 512x512 matrix product), so the window stays responsive */
function recompute(seed: number, n: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../engine/freivalds.worker.ts", import.meta.url), { type: "module" });
    const t = setTimeout(() => { w.terminate(); reject(new Error("recompute timed out")); }, 60_000);
    w.onmessage = (ev: MessageEvent<{ type: string; resultHash?: string }>) => {
      if (ev.data.type === "ready" && ev.data.resultHash) { clearTimeout(t); w.terminate(); resolve(ev.data.resultHash); }
    };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); reject(new Error(e.message)); };
    w.postMessage({ type: "start", seed, n, plantFault: false });
  });
}

const client = createPublicClient({ chain: genesisChain, transport: http(TESTNET.rpc) });
const vsAbi = parseAbi(["function isValidator(address) view returns (bool)", "function core(address) view returns (bool)"]);
const ptsAbi = parseAbi([
  "function epochBatches(uint256) view returns (uint256)",
  "function validatorSigs(uint256, address) view returns (uint256)",
]);

export type ValidatorStatus = { registered: boolean; epochBatches: number; signedThisEpoch: number };
export async function validatorStatus(): Promise<ValidatorStatus> {
  const a = validatorAddress();
  const registered = OPEN.validators ? await client.readContract({ address: OPEN.validators, abi: vsAbi, functionName: "isValidator", args: [a] }).catch(() => false) : false;
  const ep = BigInt(Math.floor(Date.now() / 1000 / 86400 / 7));
  const [b, s] = await Promise.all([
    client.readContract({ address: TESTNET.nodePoints, abi: ptsAbi, functionName: "epochBatches", args: [ep] }).catch(() => BigInt(0)),
    client.readContract({ address: TESTNET.nodePoints, abi: ptsAbi, functionName: "validatorSigs", args: [ep, a] }).catch(() => BigInt(0)),
  ]);
  return { registered, epochBatches: Number(b), signedThisEpoch: Number(s) };
}

export type PassResult = { signed: number; refused: number; skipped: number; log: string[] };

/** one pass over the open proposals: re-check each new one, sign the good ones, remember every decision */
export async function validatePass(): Promise<PassResult> {
  const acct = privateKeyToAccount(validatorKey());
  const res = await fetch(`${SITE_ORIGIN}/api/open/cosign/pending?signer=${acct.address}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`relay: ${res.status}`);
  const { proposals = [] } = (await res.json()) as { proposals?: Proposal[] };
  const st = load(); const out: PassResult = { signed: 0, refused: 0, skipped: 0, log: [] };
  const ledger: Ledger = {
    batchOf: (k) => st.rows[keyStr(k)]?.b,
    maxTs: (id, except) => {
      let m: number | null = null;
      for (const [k, v] of Object.entries(st.rows)) if (k.startsWith(`${id}:`) && v.b !== except) m = m == null ? v.ts : Math.max(m, v.ts);
      return m;
    },
  };
  for (const p of proposals) {
    const b = String(p.batchId);
    if (st.decided[b]) { out.skipped++; continue; }
    let check;
    try { check = await checkProposal(p, ledger, recompute); }
    catch (e) { out.log.push(`batch ${b.slice(0, 10)}…: check error, will retry (${e instanceof Error ? e.message.slice(0, 80) : e})`); continue; }
    const now = Math.floor(Date.now() / 1000);
    if (check.reason) {
      st.decided[b] = { ok: false, why: check.reason, at: now }; out.refused++;
      out.log.push(`refused batch ${b.slice(0, 10)}…: ${check.reason}`); continue;
    }
    const sig = await acct.sign({ hash: p.digest as Hex });
    const r = await fetch(`${SITE_ORIGIN}/api/open/cosign/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: b, sig }) });
    if (!r.ok) { out.log.push(`batch ${b.slice(0, 10)}…: relay refused the signature (${r.status} ${(await r.text()).slice(0, 80)})`); continue; }
    for (const k of check.keys) st.rows[keyStr(k)] = { b, ts: k[1] };
    st.decided[b] = { ok: true, why: "signed", at: now }; out.signed++;
    out.log.push(`signed batch ${b.slice(0, 10)}… (${p.ids.length} cards, day ${p.day})`);
  }
  save(st);
  return out;
}
