/**
 * Phone-node session key: the staker's wallet signs ONCE per node session to approve a throwaway key that lives only in
 * this browser tab (sessionStorage). That key then signs each 10-minute batch silently, so an unattended phone keeps
 * sending without a wallet prompt every 10 minutes. The attestor (delphi-genesis-node script/attestor.py) checks:
 * batch sig == sessionKey, sessionSig == staker wallet over sessionMessage(), ts <= expires, expires - ts <= 7 days.
 * The key can only sign this card's batches until it expires; it holds no funds and can't move anything.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const SESSION_TTL_SEC = 24 * 3600;
const MIN_LEFT_SEC = 15 * 60; // don't start a batch on a session about to expire

export type NodeSession = { tokenId: number; wallet: string; key: Hex; address: string; expires: number; sig: string };

/** Must match session_msg() in the attestor byte for byte. */
export function sessionMessage(tokenId: number, sessionAddress: string, expires: number): string {
  return `delphi-node-session:v1:46630:${tokenId}:${sessionAddress.toLowerCase()}:${expires}`;
}

function storageKey(tokenId: number, wallet: string) {
  return `delphi-node-session-${tokenId}-${wallet.toLowerCase()}`;
}

export function usable(s: NodeSession | null, tokenId: number, wallet: string, nowSec = Math.floor(Date.now() / 1000)): s is NodeSession {
  return !!s && s.tokenId === tokenId && s.wallet.toLowerCase() === wallet.toLowerCase() && s.expires - nowSec > MIN_LEFT_SEC;
}

export function loadSession(tokenId: number, wallet: string): NodeSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey(tokenId, wallet));
    const s = raw ? (JSON.parse(raw) as NodeSession) : null;
    return usable(s, tokenId, wallet) ? s : null;
  } catch {
    return null;
  }
}

/** New throwaway key; `approve` must return the wallet's signature over sessionMessage(). */
export async function createSession(
  tokenId: number,
  wallet: string,
  approve: (message: string) => Promise<string>,
): Promise<NodeSession> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const sig = await approve(sessionMessage(tokenId, address, expires));
  const s: NodeSession = { tokenId, wallet, key, address, expires, sig };
  try {
    sessionStorage.setItem(storageKey(tokenId, wallet), JSON.stringify(s));
  } catch {}
  return s;
}

/** Signs a batch message with the session key; returns the fields the batch payload carries. */
export async function signWithSession(s: NodeSession, message: string) {
  const sig = await privateKeyToAccount(s.key).signMessage({ message });
  return { sig, sessionKey: s.address, sessionExpires: s.expires, sessionSig: s.sig };
}
