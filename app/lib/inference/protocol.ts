/**
 * Delphi private inference: the wire protocol shared by the site (relay + browser client) and the desktop node.
 *
 * How a request travels (see INFERENCE.md):
 *   1. A node announces itself: its X25519 public key and the models it serves, signed by its node session key, which
 *      the card's wallet approved (the same approval the node already uses for its batches). So a node's encryption
 *      key is vouched for by a wallet, not by Delphi: the relay can't swap in a key of its own.
 *   2. The requester's device seals the request to that node key (X25519 + HKDF-SHA256 + XChaCha20-Poly1305) and posts
 *      the sealed envelope. The relay stores and forwards ciphertext only.
 *   3. The node opens it, runs the model locally, seals the answer to the requester's one-time key, and posts it with
 *      a signed receipt (model, token counts, ciphertext hash) that rewards and spot-checks are built on.
 *
 * Everything here is versioned (`v`) so later steps (private tier with hardware attestation, spot checks, rewards)
 * plug in without breaking nodes already running.
 */

import { sha256Hex } from "./e2e";

export const PROTOCOL_VERSION = 1;

/** Hermes and other agents need at least this much context; every model we serve gets it. */
export const MIN_CONTEXT = 65_536;

/** caps the relay enforces on sealed payloads (base64url characters) */
export const MAX_REQUEST_B64 = 384 * 1024;
export const MAX_RESULT_B64 = 512 * 1024;

/** how long things live on the relay */
export const ANNOUNCE_TTL_SEC = 120; // nodes re-announce every minute
export const JOB_TTL_SEC = 10 * 60;
export const ANNOUNCE_EVERY_MS = 60_000;
export const POLL_EVERY_MS = 1_500;

/**
 * Who may serve a request.
 * - own:     only nodes approved by the requester's own wallet (your PC answering your phone). Fully private.
 * - open:    any community node. Encrypted end to end, but the node operator's machine sees the prompt while it runs.
 * - private: only nodes in sealed hardware whose attestation the requester verified first (data-center GPUs).
 *            Defined now so the protocol is ready; no attestation verifier is enabled yet, so nothing routes here.
 */
export type Tier = "own" | "open" | "private";
export const TIERS: Tier[] = ["own", "open", "private"];

export type ModelOffer = {
  /** catalog id, e.g. "qwen3.5-9b-q4km" (see catalog.ts) */
  id: string;
  /** sha256 of the exact weights file the node verified before serving */
  sha256: string;
  ctx: number;
  tools: boolean;
};

/** Hardware attestation for the private tier. `kind` picks the verifier; `report` is that platform's signed report. */
export type Attestation = { kind: string; report: string };

/** What a node publishes. Signed (see identity.ts) by `sessionKey`, which `wallet` approved for `tokenId`. */
export type NodeAnnouncement = {
  v: number;
  /** X25519 public key, base64url (32 bytes): requests are sealed to this */
  encKey: string;
  models: ModelOffer[];
  tiers: Tier[];
  tokenId: number;
  wallet: string;
  sessionKey: string;
  sessionExpires: number;
  /** the wallet's approval of sessionKey (sessionMessage in nodeSession.ts) */
  sessionSig: string;
  /** seconds; announcements are only valid for ANNOUNCE_TTL_SEC after this */
  ts: number;
  attestation?: Attestation;
  /** sessionKey's signature over announcementMessage(this) */
  sig: string;
};

/** What travels to the node (sealed). Shaped like the OpenAI chat request so the node can pass it to llama-server. */
export type InferRequest = {
  v: number;
  /** repeated inside the seal so the relay can't relabel a job's tier */
  tier: Tier;
  model: string;
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string; tool_call_id?: string }[];
  tools?: unknown[];
  max_tokens?: number;
  temperature?: number;
  seed?: number;
  /** requester's one-time X25519 public key (base64url): the answer is sealed to it */
  replyKey: string;
  /** own tier: proof the requester is the node's own wallet (inside the seal, so only the node sees it) */
  auth?: RequesterAuth;
};

/**
 * A device key the wallet approved for up to 7 days (one wallet signature), which then signs each own-tier request
 * without prompting. The node serves own-tier jobs only when `wallet` is its own wallet.
 */
export type RequesterAuth = { wallet: string; key: string; expires: number; approval: string; sig: string };
export const requesterApprovalMessage = (wallet: string, key: string, expires: number) =>
  `delphi-infer-requester:v1:${wallet.toLowerCase()}:${key.toLowerCase()}:${expires}`;
/** signed by the approved device key; binds the auth to this request's one-time reply key so it can't be reused */
export const requesterRequestMessage = (replyKey: string) => `delphi-infer-request:v1:${replyKey}`;

export type InferResponse = {
  v: number;
  ok: boolean;
  /** the OpenAI-style chat completion from the node's llama-server, or an error message */
  completion?: unknown;
  error?: string;
};

/** A sealed box: ephemeral sender key + nonce + ciphertext, all base64url. */
export type Sealed = { v: number; epk: string; nonce: string; ct: string };

/** Posted by the requester. `to` is the node's encKey. */
export type JobSubmit = { v: number; to: string; tier: Tier; sealed: Sealed };

/**
 * The node's signed statement about a finished job. It never contains the prompt or answer, only hashes and counts,
 * so it can be published for rewards (rewards.ts) and sampled for spot checks (verification.ts).
 */
export type Receipt = {
  v: number;
  jobId: string;
  encKey: string;
  tokenId: number;
  model: string;
  modelSha256: string;
  promptTokens: number;
  completionTokens: number;
  /** sha256 of the sealed result's ciphertext (hex): ties the receipt to what the requester received */
  resultHash: string;
  ts: number;
  sessionKey: string;
  sig: string;
};

export type JobResult = { v: number; sealed: Sealed; receipt: Receipt };

export const announcementMessage = (a: Omit<NodeAnnouncement, "sig">): string =>
  `delphi-infer-announce:v${a.v}:${a.encKey}:${a.tokenId}:${a.wallet.toLowerCase()}:${a.sessionKey.toLowerCase()}:${a.ts}:` +
  `${a.tiers.join(",")}:${a.models.map((m) => `${m.id}@${m.sha256}/${m.ctx}/${m.tools ? 1 : 0}`).join(",")}:` +
  `${a.attestation ? `${a.attestation.kind}#${sha256Hex(a.attestation.report)}` : "-"}`;

export const pollMessage = (encKey: string, ts: number): string => `delphi-infer-poll:v1:${encKey}:${ts}`;

export const receiptMessage = (r: Omit<Receipt, "sig">): string =>
  `delphi-infer-receipt:v${r.v}:${r.jobId}:${r.encKey}:${r.tokenId}:${r.model}:${r.modelSha256}:${r.promptTokens}:${r.completionTokens}:${r.resultHash}:${r.ts}`;

export const isJobId = (s: string): boolean => /^[A-Za-z0-9_-]{22}$/.test(s);
export const isB64Key = (s: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(s);
