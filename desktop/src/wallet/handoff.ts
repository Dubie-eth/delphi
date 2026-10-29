import { HANDOFF_BASE } from "../config";
import { openUrl } from "@tauri-apps/plugin-opener";

export async function openWalletConnect(): Promise<void> {
  const url = `${HANDOFF_BASE}?action=connect`;
  await openUrl(url);
}

export async function openSignMessage(message: string): Promise<void> {
  const encoded = encodeURIComponent(message);
  const url = `${HANDOFF_BASE}?action=sign&message=${encoded}`;
  await openUrl(url);
}

export async function openStakeFlow(tokenId: number, museId?: string): Promise<void> {
  let url = `${HANDOFF_BASE}?action=stake&tokenId=${tokenId}`;
  if (museId?.trim()) url += `&museId=${encodeURIComponent(museId.trim())}`;
  await openUrl(url);
}

export function parseDeepLink(href: string): Record<string, string> {
  try {
    const u = new URL(href);
    const out: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      out[k] = v;
    });
    if (u.protocol === "delphi-node:") {
      const host = u.hostname || u.pathname.replace(/^\//, "").split("/")[0];
      if (host) out.action = host;
    }
    return out;
  } catch {
    return {};
  }
}
