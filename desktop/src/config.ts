/** Testnet-only Delphi desktop node. No mainnet RPC. */
export const SITE_ORIGIN =
  import.meta.env.VITE_DELPHI_SITE_URL?.replace(/\/$/, "") ?? "https://www.delphi.site"; // not the bare domain: its redirect to www carries no CORS headers, so fetches failed

export const NODE_RESULTS_URL = `${SITE_ORIGIN}/api/node-results`;
export const HANDOFF_BASE = `${SITE_ORIGIN}/desktop/handoff`;
export const CHAIN_ID = 46630;
export const TILE = 512;
export const BATCH_SUBMIT_MS = 10 * 60 * 1000;
export const DEEP_LINK_SCHEME = "delphi-node";
