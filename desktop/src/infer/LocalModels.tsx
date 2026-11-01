import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { privateKeyToAccount } from "viem/accounts";
import { FIT_LABEL, MODELS, RUNTIMES, fitOf, formatBytes, pickRuntime, type Fit, type Hardware, type ModelEntry } from "@delphi/lib/inference/catalog";
import { MIN_CONTEXT, type Tier } from "@delphi/lib/inference/protocol";
import { InferenceNode, llamaServerCompleter, offerFor, type NodeEvent } from "@delphi/lib/inference/node";
import { approvalValid, sessionKey, type DesktopApproval } from "../node/link";
import { SITE_ORIGIN } from "../config";
import * as native from "./native";

const FIT_COLOR: Record<Fit, string> = { green: "#4ade80", amber: "#fbbf24", red: "#f87171" };
const SERVE_KEY = "delphi-infer-serve";

const hexToBytes = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

/**
 * Local models, Hermes-style: pick a model that fits this machine, download it (hash-checked), run it.
 * It's then an OpenAI-compatible endpoint on this computer (for Hermes or any agent), and can answer your own
 * devices or the network through the end-to-end encrypted relay.
 */
export default function LocalModels({ approval }: { approval: DesktopApproval | null }) {
  const [hw, setHw] = useState<Hardware | null>(null);
  const [cfg, setCfg] = useState<native.Settings | null>(null);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [files, setFiles] = useState<Record<string, native.FileStatus>>({});
  const [progress, setProgress] = useState<Record<string, native.Progress>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [st, setSt] = useState<native.Status | null>(null);
  const [healthy, setHealthy] = useState(false);
  const [serve, setServe] = useState<Tier[]>(() => { try { return JSON.parse(localStorage.getItem(SERVE_KEY) || "[]"); } catch { return []; } });
  const [events, setEvents] = useState<string[]>([]);
  const [test, setTest] = useState({ q: "", a: "" });
  const nodeRef = useRef<InferenceNode | null>(null);

  const refreshFiles = useCallback(async () => {
    const list = await native.modelsStatus(MODELS).catch(() => []);
    setFiles(Object.fromEntries(list.map((f) => [f.file, f])));
  }, []);

  useEffect(() => {
    void (async () => {
      const [h, s] = await Promise.all([native.hardware(), native.settings()]);
      setHw(h);
      setCfg(s);
      const id = s.runtimeId ?? pickRuntime(h).id;
      setRuntimeId(id);
      setRuntimeReady(!!(await native.runtimePath(id)));
      await refreshFiles();
    })().catch((e) => setMsg(String(e)));
    const un = native.onProgress((p) => setProgress((x) => ({ ...x, [p.id]: p })));
    return () => { void un.then((f) => f()); };
  }, [refreshFiles]);

  useEffect(() => {
    const t = setInterval(() => void native.status().then(setSt).catch(() => undefined), 2000);
    void native.status().then(setSt);
    return () => clearInterval(t);
  }, []);

  const running = st?.running ?? null;
  const runningModel = useMemo(() => MODELS.find((m) => m.file === running?.model_file) ?? null, [running?.model_file]);
  const builds = hw ? RUNTIMES.filter((r) => r.os === hw.os && r.arch === hw.arch) : [];

  const act = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label); setMsg("");
    try { await f(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const install = () => act("runtime", async () => {
    const r = RUNTIMES.find((x) => x.id === runtimeId)!;
    await native.installRuntime(r);
    setRuntimeReady(true);
    setCfg(await native.settings());
  });

  const download = (m: ModelEntry) => act(m.id, async () => { await native.downloadModel(m); await refreshFiles(); });
  const remove = (m: ModelEntry) => act(m.id, async () => { await native.deleteModel(m); await refreshFiles(); });

  const use = (m: ModelEntry) => act(m.id, async () => {
    if (!runtimeId || !runtimeReady) throw new Error("Install the runtime first.");
    setHealthy(false);
    const { port, apiKey } = await native.start(runtimeId, m, MIN_CONTEXT);
    setMsg(`Loading ${m.name}…`);
    const ok = await native.waitHealthy(port, apiKey);
    setHealthy(ok);
    setMsg(ok ? `${m.name} is running.` : "The model didn't come up. See the log below.");
  });

  const stopModel = () => act("stop", async () => { nodeRef.current?.stop(); nodeRef.current = null; await native.stop(); setHealthy(false); });

  // health after a restart of this window
  useEffect(() => {
    if (running && cfg && !healthy) void native.waitHealthy(running.port, cfg.apiKey, 5000).then(setHealthy);
  }, [running, cfg, healthy]);

  // serving on the network: own devices and/or open tier, through the encrypted relay
  useEffect(() => {
    try { localStorage.setItem(SERVE_KEY, JSON.stringify(serve)); } catch { /* ignore */ }
    nodeRef.current?.stop();
    nodeRef.current = null;
    if (!serve.length || !running || !healthy || !runningModel || !cfg || !approvalValid(approval)) return;
    let cancelled = false;
    void native.nodeSecretHex().then((secretHex) => {
      if (cancelled) return;
      const acct = privateKeyToAccount(sessionKey());
      const node = new InferenceNode({
        origin: SITE_ORIGIN,
        secret: hexToBytes(secretHex),
        session: { tokenId: approval.tokenId, wallet: approval.wallet, sessionKey: approval.key, sessionExpires: approval.expires, sessionSig: approval.sig },
        sign: (message) => acct.signMessage({ message }),
        models: [offerFor(runningModel.id, runningModel.sha256, runningModel.tools)],
        tiers: serve,
        complete: llamaServerCompleter(`http://127.0.0.1:${running.port}`, cfg.apiKey),
        onEvent: (e: NodeEvent) => setEvents((l) => [`${new Date().toLocaleTimeString()} ${describe(e)}`, ...l].slice(0, 25)),
      });
      nodeRef.current = node;
      node.start();
    });
    return () => { cancelled = true; nodeRef.current?.stop(); };
  }, [serve, running, healthy, runningModel, cfg, approval]);

  const ask = () => act("test", async () => {
    if (!running || !cfg) return;
    const c = await llamaServerCompleter(`http://127.0.0.1:${running.port}`, cfg.apiKey)({
      v: 1, tier: "own", model: runningModel?.id ?? "local", replyKey: "", max_tokens: 400, messages: [{ role: "user", content: test.q }],
    });
    const m = (c.completion as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
    setTest((t) => ({ ...t, a: `${m.trim()}\n\n(${c.completionTokens} tokens)` }));
  });

  if (!hw || !cfg) return <div className="panel"><strong>Local models</strong><p className="muted">{msg || "Checking this computer…"}</p></div>;

  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramBytes ?? 0));
  const endpoint = running ? `http://127.0.0.1:${running.port}/v1` : null;

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      <strong>Local models</strong>
      <p className="muted" style={{ margin: 0 }}>
        Run an open model on this computer: for yourself (Hermes or any app that speaks the OpenAI API), and, if you
        choose, for your other devices or the Delphi network. Every download is checked against its pinned hash.
      </p>
      <p className="muted" style={{ margin: 0 }}>
        This computer: {formatBytes(hw.ramBytes)} RAM ·{" "}
        {hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramBytes ? ` (${formatBytes(g.vramBytes)})` : ""}`).join(", ") : "no GPU found (CPU only)"}
        {hw.os !== "macos" && hw.gpus.length && !vram ? " · GPU memory unknown, fit is a cautious guess" : ""}
      </p>

      <div>
        <span className="muted">Runtime (llama.cpp): </span>
        <select value={runtimeId ?? ""} onChange={(e) => { setRuntimeId(e.target.value); void native.runtimePath(e.target.value).then((p) => setRuntimeReady(!!p)); }} disabled={!!busy}>
          {builds.map((b) => <option key={b.id} value={b.id}>{b.backend.toUpperCase()} ({formatBytes(b.assets.reduce((s, a) => s + a.size, 0))})</option>)}
        </select>{" "}
        {runtimeReady ? <span style={{ color: FIT_COLOR.green }}>installed</span> : (
          <button className="btn-outline" disabled={!!busy} onClick={() => void install()}>
            {busy === "runtime" ? pct(progress[`runtime:${runtimeId}`]) : "Install runtime"}
          </button>
        )}
      </div>

      <div className="muted" style={{ wordBreak: "break-all" }}>
        Models folder: {cfg.modelDir}{" "}
        <button className="btn-outline" disabled={!!busy} onClick={() => void act("dir", async () => {
          const d = await openDialog({ directory: true, title: "Where should models be stored? (an external drive is fine)" });
          if (typeof d === "string") { await native.setModelDir(d); setCfg(await native.settings()); await refreshFiles(); }
        })}>Change</button>
        {cfg.modelDir !== cfg.defaultModelDir && (
          <button className="btn-outline" style={{ marginLeft: 6 }} disabled={!!busy} onClick={() => void act("dir", async () => { await native.setModelDir(null); setCfg(await native.settings()); await refreshFiles(); })}>Use default</button>
        )}
      </div>

      {MODELS.map((m) => {
        const fit = fitOf(m, hw);
        const f = files[m.file];
        const p = progress[m.id];
        const isRunning = running?.model_file === m.file;
        return (
          <div key={m.id} style={{ border: "1px solid #3a3320", borderRadius: 8, padding: "0.5rem 0.6rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span><strong>{m.name}</strong> <span className="muted">{formatBytes(m.size)}{m.tools ? " · tools" : " · chat only"}</span></span>
              <span style={{ color: FIT_COLOR[fit] }}>● {FIT_LABEL[fit]}</span>
            </div>
            <p className="muted" style={{ margin: "0.2rem 0" }}>{m.note}</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {f?.ready ? (
                <>
                  {isRunning ? (
                    <button className="btn-outline" disabled={!!busy} onClick={() => void stopModel()}>Stop</button>
                  ) : (
                    <button className="btn-gold" disabled={!!busy || fit === "red" || !runtimeReady} onClick={() => void use(m)}>{busy === m.id ? "Starting…" : "Use"}</button>
                  )}
                  {!isRunning && <button className="btn-outline" disabled={!!busy} onClick={() => void remove(m)}>Delete</button>}
                </>
              ) : busy === m.id ? (
                <>
                  <span className="muted">{pct(p)}</span>
                  <button className="btn-outline" onClick={() => void native.cancel(m.id)}>Pause</button>
                </>
              ) : (
                <button className="btn-outline" disabled={!!busy || fit === "red"} onClick={() => void download(m)}>
                  {f?.partial ? `Resume (${formatBytes(f.partial)} of ${formatBytes(m.size)})` : `Download ${formatBytes(m.size)}`}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {running && (
        <div style={{ border: "1px solid #e0b35a55", borderRadius: 8, padding: "0.6rem" }}>
          <strong>{healthy ? "● Running" : "Loading…"}: {runningModel?.name ?? running.model_file}</strong>
          <p className="muted" style={{ margin: "0.3rem 0", wordBreak: "break-all" }}>
            Use it from Hermes or any OpenAI-compatible app on this computer: <code>hermes setup</code> → Custom Endpoint.<br />
            Base URL <code>{endpoint}</code> · API key <code>{cfg.apiKey}</code> · model <code>{runningModel?.id}</code> · context {MIN_CONTEXT.toLocaleString()}
          </p>
          <button className="btn-outline" onClick={() => void navigator.clipboard.writeText(`${endpoint}\n${cfg.apiKey}\n${runningModel?.id ?? ""}`)}>Copy endpoint, key and model</button>
          {healthy && (
            <div style={{ marginTop: 8 }}>
              <textarea rows={2} style={{ width: "100%" }} placeholder="Try it: ask anything" value={test.q} onChange={(e) => setTest({ ...test, q: e.target.value })} />
              <button className="btn-outline" disabled={!!busy || !test.q.trim()} onClick={() => void ask()}>{busy === "test" ? "Thinking…" : "Ask"}</button>
              {test.a && <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{test.a}</pre>}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <strong>Answer requests from the network</strong>
            <p className="muted" style={{ margin: "0.2rem 0" }}>
              Requests are encrypted end to end: Delphi&apos;s servers only pass along sealed data. Your computer decrypts
              and runs them, so on the open network you (the operator) could in principle see prompts; senders are told that.
            </p>
            {!approvalValid(approval) ? (
              <p className="muted">Link this computer above first: serving is signed with that approval.</p>
            ) : (
              <>
                <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={serve.includes("own")} onChange={(e) => setServe((s) => toggle(s, "own", e.target.checked))} />
                  My own devices (delphi.site/run with this wallet). Fully private.
                </label>
                <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={serve.includes("open")} onChange={(e) => setServe((s) => toggle(s, "open", e.target.checked))} />
                  The open network (testnet). Others&apos; requests; rewards come in a later update.
                </label>
                {events.length > 0 && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 160, overflow: "auto" }}>{events.join("\n")}</pre>}
              </>
            )}
          </div>
        </div>
      )}

      {msg && <p className="muted" style={{ margin: 0 }}>{msg}</p>}
      {st?.exited && <p style={{ color: FIT_COLOR.red, margin: 0 }}>{st.exited}</p>}
      {st && st.log.length > 0 && (
        <details>
          <summary className="muted">Model server log</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 200, overflow: "auto" }}>{st.log.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function pct(p?: native.Progress): string {
  if (!p) return "Starting…";
  if (p.stage === "extract") return "Unpacking…";
  if (p.stage === "verified") return "Verified";
  return `${Math.floor((100 * p.done) / Math.max(1, p.total))}% of ${formatBytes(p.total)}`;
}

const toggle = (s: Tier[], t: Tier, on: boolean): Tier[] => (on ? [...new Set([...s, t])] : s.filter((x) => x !== t));

function describe(e: NodeEvent): string {
  switch (e.kind) {
    case "announced": return `online${e.queued ? ` · ${e.queued} waiting` : ""}`;
    case "job": return `request (${e.tier}) for ${e.model}`;
    case "done": return `answered: ${e.tokens} tokens in ${(e.ms / 1000).toFixed(1)} s`;
    case "refused": return `declined: ${e.reason}`;
    case "error": return `problem: ${e.message}`;
  }
}
