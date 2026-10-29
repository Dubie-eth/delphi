/**
 * Live on/off state of a phone node, so the card app and widget change color the moment the node starts or stops
 * instead of waiting for the attestor (every 15 min) to credit points.
 *
 * The phone node posts a heartbeat to /api/cards/<id>/live every minute while running and once on Stop, signed by its
 * session key (approved by the staker's wallet once per session; see nodeSession.ts). Only the card's on-chain staker
 * can set it. A "running" heartbeat older than LIVE_FRESH_SEC counts as stopped (tab closed, phone died, no signal).
 * This is display only: points still come from the attestor checking the signed batches.
 */
import { verifyMessage, type Address, type Hex } from "viem";
import type { Redis } from "@upstash/redis";
import { sessionMessage } from "./nodeSession";

export const LIVE_FRESH_SEC = 3 * 60; // heartbeats every 60 s; 3 missed = stopped
export const LIVE_TTL_SEC = 60 * 60; // after an hour without heartbeats, fall back to on-chain credit only
export const LIVE_SKEW_SEC = 120;
export const SESSION_MAX_SEC = 7 * 86400;

export const MAX_RATE100 = 10_000_000; // 100k checks/s: anything above is not a phone

/** rate100: the node's measured checks per second x100 over the last minute (display only, as reported). */
export type Live = { running: boolean; ts: number; rate100?: number };

/** Message the session key signs for each heartbeat. */
export function liveMessage(tokenId: number, wallet: string, running: boolean, ts: number, rate100: number): string {
  return `delphi-node-live:v1:46630:${tokenId}:${wallet.toLowerCase()}:${running ? 1 : 0}:${ts}:${rate100}`;
}

const key = (id: number) => `cards:live:${id}`;

export async function getLive(r: Redis, id: number): Promise<Live | null> {
  const v = await r.get<Live>(key(id));
  return v && typeof v.ts === "number" ? { running: !!v.running, ts: v.ts, rate100: typeof v.rate100 === "number" ? v.rate100 : 0 } : null;
}

/** Last rejected heartbeat for a card (public: it's only the reason), for troubleshooting a node that won't go green. */
export async function putLiveError(r: Redis, id: number, error: string): Promise<void> {
  await r.set(`cards:live:err:${id}`, { error: error.slice(0, 160), at: Math.floor(Date.now() / 1000) }, { ex: 24 * 3600 }).catch(() => {});
}
export async function getLiveError(r: Redis, id: number): Promise<{ error: string; at: number } | null> {
  return (await r.get<{ error: string; at: number }>(`cards:live:err:${id}`).catch(() => null)) ?? null;
}

/** Stores the heartbeat unless a newer one is already stored. */
export async function putLive(r: Redis, id: number, live: Live): Promise<void> {
  const prev = await getLive(r, id);
  if (prev && prev.ts > live.ts) return;
  await r.set(key(id), live, { ex: LIVE_TTL_SEC });
}

export type LiveBody = {
  wallet: string;
  running: boolean;
  ts: number;
  rate100: number;
  sig: string;
  sessionKey: string;
  sessionExpires: number;
  sessionSig: string;
};

const isAddr = (x: unknown): x is Address => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const isSig = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{130}$/.test(x);

export function parseLive(x: unknown): LiveBody | null {
  if (!x || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  if (!isAddr(b.wallet) || !isAddr(b.sessionKey) || typeof b.running !== "boolean") return null;
  if (!Number.isInteger(b.rate100) || (b.rate100 as number) < 0 || (b.rate100 as number) > MAX_RATE100) return null;
  if (!Number.isInteger(b.ts) || !Number.isInteger(b.sessionExpires) || !isSig(b.sig) || !isSig(b.sessionSig)) return null;
  return b as unknown as LiveBody;
}

/** Signature and time checks (the staker check needs the chain and is done by the route). */
export async function verifyLive(id: number, b: LiveBody, now: number): Promise<string | null> {
  if (Math.abs(now - b.ts) > LIVE_SKEW_SEC) return "heartbeat time is off; check the phone's clock";
  if (b.ts > b.sessionExpires) return "node session expired; press Stop then Start";
  if (b.sessionExpires - b.ts > SESSION_MAX_SEC) return "node session too long";
  const okSession = await verifyMessage({
    address: b.wallet as Address,
    message: sessionMessage(id, b.sessionKey, b.sessionExpires),
    signature: b.sessionSig as Hex,
  }).catch(() => false);
  if (!okSession) return "session not approved by this wallet";
  const okBeat = await verifyMessage({
    address: b.sessionKey as Address,
    message: liveMessage(id, b.wallet, b.running, b.ts, b.rate100),
    signature: b.sig as Hex,
  }).catch(() => false);
  if (!okBeat) return "bad heartbeat signature";
  return null;
}
