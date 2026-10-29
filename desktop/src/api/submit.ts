import { NODE_RESULTS_URL, SITE_ORIGIN } from "../config";

export type NodeSubmitBody = {
  label: string;
  userAgent: string;
  cores: number;
  deviceMemory: number | null;
  stats: Record<string, unknown>;
  tokenId: number;
  wallet: string;
  resultHash: string;
  checks: number;
  durationSec: number;
  ts: number;
  anchorBlock: number;
  n: number;
  sig: string;
  /** present when signed by this computer's approved node key (no wallet prompt) */
  sessionKey?: string;
  sessionExpires?: number;
  sessionSig?: string;
};

export async function postNodeResults(body: NodeSubmitBody): Promise<void> {
  const res = await fetch(NODE_RESULTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "submit failed");
  }
}

/** live on/off heartbeat for the card's status (delphi.site/api/cards/<id>/live) */
export async function postLive(
  tokenId: number,
  body: { wallet: string; running: boolean; ts: number; rate100: number; sig: string; sessionKey: string; sessionExpires: number; sessionSig: string },
): Promise<string | null> {
  try {
    const res = await fetch(`${SITE_ORIGIN}/api/cards/${tokenId}/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return typeof j.error === "string" ? j.error : `HTTP ${res.status}`;
  } catch {
    return "no connection";
  }
}
