/**
 * The serving side of a node: announce, collect sealed jobs, run them on the local model, return sealed answers with
 * signed receipts. Used by the desktop app (with llama-server as `complete`) and by tests (with a fake model).
 * Jobs run one at a time: a home GPU runs one generation well, not several badly.
 */
import { b64u, fromB64u, keyPairFromSecret, openJson, seal, sha256Hex, type KeyPair } from "./e2e";
import { signAnnouncement, signReceipt, verifyRequester, type Signer } from "./identity";
import {
  ANNOUNCE_EVERY_MS, MIN_CONTEXT, POLL_EVERY_MS, PROTOCOL_VERSION, pollMessage,
  type InferRequest, type InferResponse, type ModelOffer, type NodeAnnouncement, type Sealed, type Tier,
} from "./protocol";

export type NodeSessionInfo = { tokenId: number; wallet: string; sessionKey: string; sessionExpires: number; sessionSig: string };

export type Completion = { completion: unknown; promptTokens: number; completionTokens: number };

export type NodeOptions = {
  origin: string;
  /** this node's X25519 secret (32 bytes); kept on the machine */
  secret: Uint8Array;
  session: NodeSessionInfo;
  /** signs with the node session key */
  sign: Signer;
  models: ModelOffer[];
  tiers: Tier[];
  /** run one chat completion on the local model */
  complete: (req: InferRequest) => Promise<Completion>;
  maxTokens?: number;
  onEvent?: (e: NodeEvent) => void;
  fetchImpl?: typeof fetch;
};

export type NodeEvent =
  | { kind: "announced"; queued: number }
  | { kind: "job"; id: string; tier: Tier; model: string }
  | { kind: "done"; id: string; ms: number; tokens: number }
  | { kind: "refused"; id: string; reason: string }
  | { kind: "error"; message: string };

export class InferenceNode {
  private keys: KeyPair;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private busy = false;
  readonly encKey: string;

  constructor(private o: NodeOptions) {
    this.keys = keyPairFromSecret(o.secret);
    this.encKey = b64u(this.keys.publicKey);
  }

  private get f() { return this.o.fetchImpl ?? fetch; }
  private emit(e: NodeEvent) { this.o.onEvent?.(e); }

  async announce(): Promise<void> {
    const s = this.o.session;
    const a: NodeAnnouncement = await signAnnouncement({
      v: PROTOCOL_VERSION, encKey: this.encKey, models: this.o.models, tiers: this.o.tiers,
      tokenId: s.tokenId, wallet: s.wallet, sessionKey: s.sessionKey, sessionExpires: s.sessionExpires, sessionSig: s.sessionSig,
      ts: Math.floor(Date.now() / 1000),
    }, this.o.sign);
    const r = await this.f(`${this.o.origin}/api/infer/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `announce failed (${r.status})`);
    this.emit({ kind: "announced", queued: j.queued ?? 0 });
  }

  /** collect and run waiting jobs once; returns how many ran */
  async pollOnce(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sig = await this.o.sign(pollMessage(this.encKey, ts));
      const r = await this.f(`${this.o.origin}/api/infer/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encKey: this.encKey, ts, sig }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `poll failed (${r.status})`);
      const jobs = (j.jobs ?? []) as { id: string; tier: Tier; sealed: Sealed }[];
      for (const job of jobs) await this.handle(job);
      return jobs.length;
    } finally {
      this.busy = false;
    }
  }

  private async refuse(id: string, replyKey: string | null, reason: string) {
    this.emit({ kind: "refused", id, reason });
    if (replyKey) await this.reply(id, replyKey, { v: PROTOCOL_VERSION, ok: false, error: reason }, "-", "-", 0, 0).catch(() => {});
  }

  private async handle(job: { id: string; tier: Tier; sealed: Sealed }) {
    let req: InferRequest;
    try {
      req = openJson<InferRequest>(this.keys, job.sealed, "request");
    } catch {
      return this.emit({ kind: "refused", id: job.id, reason: "couldn't open (not sealed to this node)" });
    }
    if (req.v !== PROTOCOL_VERSION || typeof req.replyKey !== "string" || fromB64u(req.replyKey).length !== 32) {
      return this.emit({ kind: "refused", id: job.id, reason: "malformed request" });
    }
    if (req.tier !== job.tier || !this.o.tiers.includes(req.tier)) return this.refuse(job.id, req.replyKey, "this node doesn't serve that tier");
    if (req.tier === "own" && !(await verifyRequester(req.auth, req.replyKey, this.o.session.wallet))) {
      return this.refuse(job.id, req.replyKey, "own-device requests must come from this node's wallet");
    }
    const offer = this.o.models.find((m) => m.id === req.model);
    if (!offer) return this.refuse(job.id, req.replyKey, `model ${req.model} isn't loaded here`);
    if (!Array.isArray(req.messages) || req.messages.length === 0) return this.refuse(job.id, req.replyKey, "no messages");
    const cap = this.o.maxTokens ?? 4096;
    const clean: InferRequest = { ...req, max_tokens: Math.min(Math.max(1, req.max_tokens ?? 1024), cap) };
    delete clean.auth;
    this.emit({ kind: "job", id: job.id, tier: req.tier, model: req.model });
    const t0 = Date.now();
    try {
      const c = await this.o.complete(clean);
      await this.reply(job.id, req.replyKey, { v: PROTOCOL_VERSION, ok: true, completion: c.completion }, offer.id, offer.sha256, c.promptTokens, c.completionTokens);
      this.emit({ kind: "done", id: job.id, ms: Date.now() - t0, tokens: c.completionTokens });
    } catch (e) {
      await this.refuse(job.id, req.replyKey, `model error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }

  private async reply(id: string, replyKey: string, res: InferResponse, model: string, modelSha256: string, promptTokens: number, completionTokens: number) {
    const sealed = seal(replyKey, res, "response");
    const s = this.o.session;
    const receipt = await signReceipt({
      v: PROTOCOL_VERSION, jobId: id, encKey: this.encKey, tokenId: s.tokenId, model, modelSha256: modelSha256 === "-" ? "0".repeat(64) : modelSha256,
      promptTokens, completionTokens, resultHash: sha256Hex(fromB64u(sealed.ct)), ts: Math.floor(Date.now() / 1000), sessionKey: s.sessionKey,
    }, this.o.sign);
    const r = await this.f(`${this.o.origin}/api/infer/jobs/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: PROTOCOL_VERSION, sealed, receipt }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `result rejected (${r.status})`);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const announceLoop = async () => {
      if (!this.running) return;
      try { await this.announce(); } catch (e) { this.emit({ kind: "error", message: e instanceof Error ? e.message : String(e) }); }
      this.timers.push(setTimeout(announceLoop, ANNOUNCE_EVERY_MS));
    };
    const pollLoop = async () => {
      if (!this.running) return;
      try { await this.pollOnce(); } catch (e) { this.emit({ kind: "error", message: e instanceof Error ? e.message : String(e) }); }
      this.timers.push(setTimeout(pollLoop, POLL_EVERY_MS));
    };
    void announceLoop().then(() => pollLoop());
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/** Run a request on a local llama-server (OpenAI-compatible). Used by the desktop node. */
export function llamaServerCompleter(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): NodeOptions["complete"] {
  return async (req) => {
    const r = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: req.model, messages: req.messages, tools: req.tools, max_tokens: req.max_tokens,
        temperature: req.temperature ?? 0.7, seed: req.seed, stream: false,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? `llama-server ${r.status}`);
    return { completion: j, promptTokens: j?.usage?.prompt_tokens ?? 0, completionTokens: j?.usage?.completion_tokens ?? 0 };
  };
}

export const offerFor = (id: string, sha256: string, tools: boolean): ModelOffer => ({ id, sha256, ctx: MIN_CONTEXT, tools });
