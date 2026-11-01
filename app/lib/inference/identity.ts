/**
 * Who a node is, and proof of it. Chain of trust for a node's encryption key:
 *   card wallet --signs sessionMessage--> node session key --signs announcementMessage--> encKey (+ models, tiers)
 * The browser checks this chain itself, so the relay (Delphi's servers) can't substitute a key it controls.
 * Whether that wallet still owns or stakes the card is checked where it matters for money (rewards, slashing), via the
 * pluggable `ownership` check, and is not needed for privacy.
 */
import { recoverMessageAddress, type Hex } from "viem";
import { sessionMessage } from "../nodeSession";
import {
  ANNOUNCE_TTL_SEC, PROTOCOL_VERSION, TIERS, announcementMessage, isB64Key, pollMessage, receiptMessage,
  requesterApprovalMessage, requesterRequestMessage, type NodeAnnouncement, type Receipt, type RequesterAuth,
} from "./protocol";

const MAX_SESSION_SEC = 7 * 86400 + 300;
const lower = (s: string) => s.toLowerCase();

export type Signer = (message: string) => Promise<Hex>;

export async function signAnnouncement(a: Omit<NodeAnnouncement, "sig">, sign: Signer): Promise<NodeAnnouncement> {
  return { ...a, sig: await sign(announcementMessage(a)) };
}

/** Optional: does `wallet` still own or stake `tokenId`? (rewards/slashing plug this in; privacy doesn't need it) */
export type OwnershipCheck = (tokenId: number, wallet: string) => Promise<boolean>;

/** Returns the problem, or null if the announcement is genuine, current, and well-formed. */
export async function verifyAnnouncement(
  a: NodeAnnouncement,
  opts: { nowSec?: number; ownership?: OwnershipCheck } = {},
): Promise<string | null> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (a?.v !== PROTOCOL_VERSION) return "unsupported protocol version";
  if (!isB64Key(a.encKey)) return "bad encryption key";
  if (!Number.isInteger(a.tokenId) || a.tokenId < 1) return "bad card id";
  if (!Array.isArray(a.tiers) || a.tiers.length === 0 || a.tiers.some((t) => !TIERS.includes(t))) return "bad tiers";
  if (!Array.isArray(a.models) || a.models.length === 0 || a.models.length > 16) return "bad model list";
  for (const m of a.models) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(m.id) || !/^[0-9a-f]{64}$/.test(m.sha256) || !(m.ctx > 0)) return "bad model entry";
  }
  if (a.tiers.includes("private") && !a.attestation) return "private tier needs an attestation";
  if (!(a.ts <= now + 60 && now - a.ts <= ANNOUNCE_TTL_SEC)) return "stale announcement";
  if (!(a.sessionExpires > now && a.sessionExpires - now <= MAX_SESSION_SEC)) return "node approval expired";
  const approver = await recoverMessageAddress({ message: sessionMessage(a.tokenId, a.sessionKey, a.sessionExpires), signature: a.sessionSig as Hex }).catch(() => null);
  if (!approver || lower(approver) !== lower(a.wallet)) return "node key isn't approved by that wallet";
  const { sig, ...unsigned } = a;
  const signer = await recoverMessageAddress({ message: announcementMessage(unsigned), signature: sig as Hex }).catch(() => null);
  if (!signer || lower(signer) !== lower(a.sessionKey)) return "announcement isn't signed by the node key";
  if (opts.ownership && !(await opts.ownership(a.tokenId, a.wallet))) return "wallet no longer holds that card";
  return null;
}

/** node -> relay: proof that the poller holds the session key behind an announcement */
export async function verifyPoll(a: NodeAnnouncement, ts: number, sig: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (Math.abs(nowSec - ts) > 120) return false;
  const signer = await recoverMessageAddress({ message: pollMessage(a.encKey, ts), signature: sig as Hex }).catch(() => null);
  return !!signer && lower(signer) === lower(a.sessionKey);
}

export async function signReceipt(r: Omit<Receipt, "sig">, sign: Signer): Promise<Receipt> {
  return { ...r, sig: await sign(receiptMessage(r)) };
}

export async function verifyReceipt(r: Receipt, a: Pick<NodeAnnouncement, "sessionKey" | "encKey" | "tokenId">): Promise<boolean> {
  if (r.encKey !== a.encKey || r.tokenId !== a.tokenId || lower(r.sessionKey) !== lower(a.sessionKey)) return false;
  const { sig, ...unsigned } = r;
  const signer = await recoverMessageAddress({ message: receiptMessage(unsigned), signature: sig as Hex }).catch(() => null);
  return !!signer && lower(signer) === lower(a.sessionKey);
}

/** node side, own tier: is this request really from `wallet` (via a device key it approved)? */
export async function verifyRequester(auth: RequesterAuth | undefined, replyKey: string, wallet: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!auth || lower(auth.wallet) !== lower(wallet)) return false;
  if (!(auth.expires > nowSec && auth.expires - nowSec <= MAX_SESSION_SEC)) return false;
  const approver = await recoverMessageAddress({ message: requesterApprovalMessage(auth.wallet, auth.key, auth.expires), signature: auth.approval as Hex }).catch(() => null);
  if (!approver || lower(approver) !== lower(wallet)) return false;
  const signer = await recoverMessageAddress({ message: requesterRequestMessage(replyKey), signature: auth.sig as Hex }).catch(() => null);
  return !!signer && lower(signer) === lower(auth.key);
}
