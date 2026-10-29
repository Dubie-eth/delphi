/**
 * This computer's node key and the wallet's approval of it: the same session approval the web and Android nodes use
 * (delphi.site/node/link, one card, up to 7 days). The key is made here and never leaves this computer; it can only
 * sign that card's node reports until the approval expires. Batches and heartbeats then go out with no wallet prompt.
 */
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sessionMessage } from "@delphi/lib/nodeSession";
import { SITE_ORIGIN } from "../config";

export type DesktopApproval = { tokenId: number; wallet: Address; key: Address; expires: number; sig: Hex };

const KEY = "delphi-desktop-session-key";
const APPROVAL = "delphi-desktop-approval";
const MAX_SEC = 7 * 86400;

export function sessionKey(): Hex {
  let k = localStorage.getItem(KEY) as Hex | null;
  if (!k) {
    k = generatePrivateKey();
    localStorage.setItem(KEY, k);
  }
  return k;
}

export const sessionAddress = (): Address => privateKeyToAccount(sessionKey()).address;

export function linkUrl(card?: number | null): string {
  return `${SITE_ORIGIN}/node/link?key=${sessionAddress()}&app=desktop${card ? `&card=${card}` : ""}`;
}

export function loadApproval(): DesktopApproval | null {
  try {
    const a = JSON.parse(localStorage.getItem(APPROVAL) || "null") as DesktopApproval | null;
    return a && a.key.toLowerCase() === sessionAddress().toLowerCase() ? a : null;
  } catch {
    return null;
  }
}

export function approvalValid(a: DesktopApproval | null, nowSec = Math.floor(Date.now() / 1000)): a is DesktopApproval {
  return !!a && a.expires - nowSec > 15 * 60;
}

/** code (or delphi-node://link?c=…) from delphi.site/node/link. Returns the problem, or null once saved. */
export async function importCode(raw: string): Promise<string | null> {
  const code = raw.trim().replace(/^.*[?&]c=/, "");
  let j: { t: number; w: Address; k: Address; e: number; s: Hex };
  try {
    j = JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, "+").replace(/_/g, "/")))));
  } catch {
    return "That isn't an approval code from delphi.site/node/link.";
  }
  const now = Math.floor(Date.now() / 1000);
  if (j.k?.toLowerCase() !== sessionAddress().toLowerCase()) return "This approval is for a different computer (node key).";
  if (!(j.e > now)) return "This approval has expired. Link again.";
  if (j.e - now > MAX_SEC + 300) return "Approval lasts longer than 7 days.";
  const signer = await recoverMessageAddress({ message: sessionMessage(j.t, j.k, j.e), signature: j.s }).catch(() => null);
  if (!signer || signer.toLowerCase() !== j.w.toLowerCase()) return "The approval isn't signed by that wallet.";
  const a: DesktopApproval = { tokenId: j.t, wallet: j.w, key: j.k, expires: j.e, sig: j.s };
  localStorage.setItem(APPROVAL, JSON.stringify(a));
  return null;
}

export function unlink() {
  localStorage.removeItem(APPROVAL);
}

/** fields a signed batch / heartbeat carries */
export async function signWithApproval(a: DesktopApproval, message: string) {
  const sig = await privateKeyToAccount(sessionKey()).signMessage({ message });
  return { sig, sessionKey: a.key, sessionExpires: a.expires, sessionSig: a.sig };
}
