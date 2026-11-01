import { useCallback, useEffect, useRef, useState } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { BATCH_SUBMIT_MS, SITE_ORIGIN, TILE } from "./config";
import {
  assertAnchorFresh,
  fetchLatestBatchAnchor,
  freivaldsSeedFromAnchor,
  type BatchAnchor,
} from "@delphi/lib/nodeBatchAnchor";
import { FreivaldsPool } from "./engine/pool";
import { postLive, postNodeResults } from "./api/submit";
import { approvalValid, importCode, linkUrl, loadApproval, signWithApproval, unlink, type DesktopApproval } from "./node/link";
import { liveMessage } from "@delphi/lib/cardLive";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openSignMessage, openStakeFlow, openWalletConnect, parseDeepLink } from "./wallet/handoff";
import {
  fetchTokenPointsView,
  listWalletBondTokens,
  buildNodeSignMessage,
  type WalletBondToken,
  type TokenPointsView,
} from "@delphi/lib/genesisNodeBond";
import type { Address } from "viem";
import ProfilePicturePicker from "@delphi/components/ProfilePicturePicker";
import { loadProfilePick, saveProfilePick, type StoredProfilePick } from "@delphi/lib/nodeProfileStorage";
import LiveCard from "./LiveCard";
import ValidatorPanel from "./ValidatorPanel";
import LocalModels from "./infer/LocalModels";
import "./styles.css";

/** heat throttle: ignore the first seconds (cores spinning up), then pause only if checks stay this much slower than the
 *  warm-up baseline for this long. Desktops throttle themselves; this is a safety net, not a hair trigger. */
const HEAT_WARMUP_SEC = 20;
const HEAT_LIMIT = 1.8;
const HEAT_SUSTAIN_SEC = 120;

export default function App() {
  const [wallet, setWallet] = useState<Address | null>(null);
  const [tokens, setTokens] = useState<WalletBondToken[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [points, setPoints] = useState<TokenPointsView | null>(null);
  const [running, setRunning] = useState(false);
  const [resultHash, setResultHash] = useState("");
  const [checks, setChecks] = useState(0);
  const [failures, setFailures] = useState(0);
  const [checksPerSec, setChecksPerSec] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [heatSlowdown, setHeatSlowdown] = useState(1);
  const [status, setStatus] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [heatThrottle, setHeatThrottle] = useState(false);
  const heatBaseRef = useRef<number | null>(null); // median check time just after warm-up
  const heatSinceRef = useRef<number | null>(null); // when checks first got HEAT_LIMIT× slower (null = they aren't)
  const [throttleOverride, setThrottleOverride] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [profilePick, setProfilePick] = useState<StoredProfilePick | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const poolRef = useRef<FreivaldsPool | null>(null);
  const checksRef = useRef(0);
  const batchStartRef = useRef(0);
  const checksAtBatchRef = useRef(0);
  const checkTimesRef = useRef<number[]>([]);
  const winRef = useRef<{ t: number; n: number }[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number | null>(null);
  const batchAnchorRef = useRef<BatchAnchor | null>(null);
  const resultHashRef = useRef("");
  const liveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveLastRef = useRef<{ checks: number; t: number } | null>(null);
  const [approval, setApproval] = useState<DesktopApproval | null>(() => loadApproval());
  const [linkCode, setLinkCode] = useState("");
  const [liveMsg, setLiveMsg] = useState("");
  const approvalRef = useRef(approval);
  approvalRef.current = approval;

  useEffect(() => {
    if (!approval) return;
    setWallet((w) => w ?? approval.wallet);
    setSelectedId((id) => id ?? approval.tokenId);
  }, [approval]);

  const useLinkCode = useCallback(async (raw: string) => {
    const problem = await importCode(raw);
    if (problem) setStatus(problem);
    else {
      const a = loadApproval();
      setApproval(a);
      if (a) {
        setWallet(a.wallet);
        setSelectedId(a.tokenId);
      }
      setLinkCode("");
      setStatus("Linked. Batches are signed automatically for 7 days; press Start node.");
    }
  }, []);

  const selected = tokens.find((t) => t.tokenId === selectedId) ?? null;
  const staked = Boolean(selected?.stakedByWallet);

  const refreshTokens = useCallback(async () => {
    if (!wallet) {
      setTokens([]);
      setTokensError(null);
      return;
    }
    setTokensLoading(true);
    setTokensError(null);
    try {
      const list = await listWalletBondTokens(wallet);
      setTokens(list);
      setSelectedId((prev) => {
        if (prev && list.some((t) => t.tokenId === prev)) return prev;
        return list.find((t) => t.stakedByWallet)?.tokenId ?? list[0]?.tokenId ?? null;
      });
    } catch (e) {
      setTokensError(e instanceof Error ? e.message : "Genesis scan failed");
      setTokens([]);
      setSelectedId(null);
    } finally {
      setTokensLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void refreshTokens();
  }, [refreshTokens]);

  useEffect(() => {
    if (!wallet || !selectedId) {
      setProfilePick(null);
      return;
    }
    setProfilePick(loadProfilePick(wallet, selectedId));
  }, [wallet, selectedId]);

  useEffect(() => {
    if (!wallet || !selectedId) {
      setPoints(null);
      return;
    }
    void fetchTokenPointsView(selectedId, wallet).then(setPoints);
    const t = setInterval(() => {
      void fetchTokenPointsView(selectedId, wallet).then(setPoints);
    }, 60_000);
    return () => clearInterval(t);
  }, [wallet, selectedId]);

  useEffect(() => {
    void isEnabled().then(setAutostart).catch(() => {});
  }, []);

  const finishBatchSubmitRef = useRef<(sig: string) => void>(() => {});
  const useLinkCodeRef = useRef<(c: string) => Promise<void>>(async () => {});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onOpenUrl((urls) => {
      for (const url of urls) {
        const p = parseDeepLink(url);
        if (p.action === "link" && p.c) {
          void useLinkCodeRef.current(p.c);
          continue;
        }
        if (p.address || p.wallet) {
          const addr = (p.address || p.wallet) as Address;
          setWallet(addr);
          setStatus(`Wallet connected: ${addr.slice(0, 8)}…`);
        }
        if (p.sig) finishBatchSubmitRef.current(p.sig);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  const buildStats = useCallback(() => {
    const times = checkTimesRef.current;
    const heat = heatSlowdown;
    return {
      tileSize: TILE,
      plantFault: false,
      checks,
      failures,
      checksPerSec: Math.round(checksPerSec * 10) / 10,
      lastCheckMs: times.length ? times[times.length - 1] : 0,
      multiplyMs512: null,
      multiplyMs1024: null,
      resultHash,
      elapsedSec: Math.round(elapsedSec * 10) / 10,
      batteryLevel: null,
      charging: null,
      heatSlowdown: Math.round(heat * 100) / 100,
      desktopThrottle: heatThrottle && !throttleOverride,
    };
  }, [checks, failures, checksPerSec, resultHash, elapsedSec, heatSlowdown, heatThrottle, throttleOverride]);

  useEffect(() => {
    useLinkCodeRef.current = useLinkCode;
  }, [useLinkCode]);

  /** this computer's approval for the selected card and wallet, if still valid */
  const activeApproval = useCallback((): DesktopApproval | null => {
    const a = approvalRef.current;
    return approvalValid(a) && a.tokenId === selectedId && !!wallet && a.wallet.toLowerCase() === wallet.toLowerCase() ? a : null;
  }, [selectedId, wallet]);

  const sendLive = useCallback(
    async (on: boolean) => {
      const a = activeApproval();
      if (!a) return;
      const ts = Math.floor(Date.now() / 1000);
      const t = performance.now();
      const prev = liveLastRef.current;
      const rate100 = on && prev && t > prev.t ? Math.max(0, Math.min(10_000_000, Math.round(((checksRef.current - prev.checks) * 100_000) / (t - prev.t)))) : 0;
      liveLastRef.current = on ? { checks: checksRef.current, t } : null;
      const signed = await signWithApproval(a, liveMessage(a.tokenId, a.wallet, on, ts, rate100));
      const err = await postLive(a.tokenId, { wallet: a.wallet, running: on, ts, rate100, ...signed });
      setLiveMsg(err ? `Card status not updated: ${err}` : on ? `Card #${a.tokenId} shows Running · ${new Date().toLocaleTimeString()}` : "");
    },
    [activeApproval],
  );

  const finishBatchSubmit = useCallback(
    async (sig: string, session?: { sessionKey: string; sessionExpires: number; sessionSig: string }) => {
      if (!wallet || !selectedId) return;
      const batchChecks = checksRef.current - checksAtBatchRef.current;
      if (batchChecks <= 0) return;
      const anchor = batchAnchorRef.current;
      if (!anchor) {
        setStatus("Missing batch anchor — restart the node.");
        return;
      }
      try {
        assertAnchorFresh(anchor);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Anchor block expired");
        return;
      }
      const durationSec = Math.max(1, Math.round((performance.now() - batchStartRef.current) / 1000));
      const ts = Math.floor(Date.now() / 1000);
      const hash = resultHashRef.current;
      if (!hash) return;
      await postNodeResults({
        label: "desktop",
        userAgent: `delphi-desktop/${navigator.userAgent}`,
        cores: navigator.hardwareConcurrency ?? 0,
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        stats: buildStats(),
        tokenId: selectedId,
        wallet,
        resultHash: hash,
        checks: batchChecks,
        durationSec,
        ts,
        anchorBlock: anchor.anchorBlock,
        n: TILE,
        sig,
        ...(session ?? {}),
      });
      checksAtBatchRef.current = checksRef.current;
      batchStartRef.current = performance.now();
      setStatus(`Submitted batch (${batchChecks} checks).`);
      if (wallet && selectedId) {
        void fetchTokenPointsView(selectedId, wallet).then(setPoints);
        const next = await fetchLatestBatchAnchor();
        batchAnchorRef.current = next;
        const seed = freivaldsSeedFromAnchor(next.blockHash, selectedId, wallet);
        resultHashRef.current = "";
        poolRef.current?.restart(seed);
      }
    },
    [wallet, selectedId, buildStats]
  );

  const finishBatchSubmitLatest = useRef(finishBatchSubmit);
  finishBatchSubmitLatest.current = finishBatchSubmit;

  useEffect(() => {
    finishBatchSubmitRef.current = (sig) => {
      void finishBatchSubmit(sig);
    };
  }, [finishBatchSubmit]);

  const requestBatchSign = useCallback(async () => {
    if (!wallet || !selectedId || !staked) return;
    const batchChecks = checksRef.current - checksAtBatchRef.current;
    if (batchChecks <= 0) return;
    const durationSec = Math.max(1, Math.round((performance.now() - batchStartRef.current) / 1000));
    const ts = Math.floor(Date.now() / 1000);
    const hash = resultHashRef.current;
    if (!hash) return; // the new challenge's result isn't ready yet: this batch goes out with the next tick
    const anchor = batchAnchorRef.current;
    if (!anchor) {
      setStatus("Missing batch anchor — restart the node.");
      return;
    }
    try {
      assertAnchorFresh(anchor);
    } catch {
      // the batch's block got too old (computer slept, or a signature waited too long): start a fresh batch on a new
      // block instead of failing every 10 minutes
      try {
        const next = await fetchLatestBatchAnchor();
        batchAnchorRef.current = next;
        checksAtBatchRef.current = checksRef.current;
        batchStartRef.current = performance.now();
        resultHashRef.current = "";
        poolRef.current?.restart(freivaldsSeedFromAnchor(next.blockHash, selectedId, wallet));
        setStatus("Started a fresh batch on a new block (the previous one got too old).");
      } catch (e) {
        setStatus(e instanceof Error ? `Could not read a fresh block: ${e.message}` : "Could not read a fresh block");
      }
      return;
    }
    const message = buildNodeSignMessage({
      tokenId: selectedId,
      resultHash: hash,
      checks: batchChecks,
      durationSec,
      ts,
      anchorBlock: anchor.anchorBlock,
      n: TILE,
    });
    const a = activeApproval();
    if (a) {
      // signed by this computer's approved node key: no wallet prompt
      const signed = await signWithApproval(a, message);
      const { sig, ...session } = signed;
      await finishBatchSubmitLatest.current(sig, session).catch((e) => setStatus(e instanceof Error ? e.message : "submit failed"));
      return;
    }
    setStatus("Sign in your browser to submit this batch… (link this computer to skip this)");
    await openSignMessage(message);
  }, [wallet, selectedId, staked, activeApproval]);

  const stopRun = useCallback(() => {
    poolRef.current?.stop();
    poolRef.current = null;
    setRunning(false);
    if (tickRef.current) clearInterval(tickRef.current);
    if (batchRef.current) clearInterval(batchRef.current);
    if (liveRef.current) clearInterval(liveRef.current);
    liveRef.current = null;
    startRef.current = null;
    void requestBatchSign();
    void sendLive(false);
  }, [requestBatchSign, sendLive]);

  const startRun = useCallback(async () => {
    if (!staked) {
      setStatus("Stake a Genesis bond first (browser handoff).");
      return;
    }
    if (!wallet || !selectedId) return;
    let anchor: BatchAnchor;
    try {
      anchor = await fetchLatestBatchAnchor();
      batchAnchorRef.current = anchor;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not read anchor block");
      return;
    }
    const seed = freivaldsSeedFromAnchor(anchor.blockHash, selectedId, wallet);
    setChecks(0);
    setFailures(0);
    checksRef.current = 0;
    checksAtBatchRef.current = 0;
    batchStartRef.current = performance.now();
    checkTimesRef.current = [];
    heatBaseRef.current = null;
    heatSinceRef.current = null;
    setHeatSlowdown(1);
    setHeatThrottle(false); // a fresh run measures heat again from scratch
    winRef.current = [];
    startRef.current = performance.now();

    const pool = new FreivaldsPool(TILE, false, {
      onReady: (hash) => {
        setResultHash(hash);
        resultHashRef.current = hash;
      },
      onCheck: (ok, ms) => {
        if (!ok) setFailures((f) => f + 1);
        setChecks((c) => {
          const n = c + 1;
          checksRef.current = n;
          return n;
        });
        const times = checkTimesRef.current;
        times.push(ms);
        if (times.length > 60) times.shift();
        const now = performance.now();
        // Heat = how much slower checks are now than right after warm-up. The first seconds are skipped (every core
        // spinning up makes checks slower for a moment, which looked like heat and paused the node after 1 s).
        const sinceStart = startRef.current ? (now - startRef.current) / 1000 : 0;
        const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
        if (sinceStart >= HEAT_WARMUP_SEC && times.length >= 30) {
          if (heatBaseRef.current == null) heatBaseRef.current = median(times);
          const base = heatBaseRef.current;
          const h = base > 0 ? median(times.slice(-30)) / base : 1;
          setHeatSlowdown(h);
          if (h > HEAT_LIMIT) { heatSinceRef.current ??= now; } else heatSinceRef.current = null;
        }
        const win = winRef.current;
        win.push({ t: now, n: 1 });
        const cutoff = now - 2000;
        while (win.length && win[0].t < cutoff) win.shift();
        setChecksPerSec(win.reduce((a, x) => a + x.n, 0) / 2);
      },
    }, seed);
    poolRef.current = pool;
    pool.start();
    setRunning(true);

    tickRef.current = setInterval(() => {
      if (startRef.current) setElapsedSec((performance.now() - startRef.current) / 1000);
    }, 500);
    batchRef.current = setInterval(() => void requestBatchSign(), BATCH_SUBMIT_MS);
    liveLastRef.current = { checks: 0, t: performance.now() };
    void sendLive(true);
    if (liveRef.current) clearInterval(liveRef.current);
    liveRef.current = setInterval(() => void sendLive(true), 60_000);
  }, [staked, requestBatchSign, wallet, selectedId, sendLive]);

  useEffect(() => {
    if (!running || throttleOverride) return;
    const since = heatSinceRef.current;
    if (since != null && performance.now() - since >= HEAT_SUSTAIN_SEC * 1000) {
      setHeatThrottle(true);
      stopRun();
    }
  }, [heatSlowdown, running, throttleOverride, stopRun]);

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <header>
        <h1 style={{ margin: 0, fontSize: "1.75rem" }}>Delphi Node</h1>
        <p className="muted" style={{ margin: "0.25rem 0 0" }}>
          Testnet {46630} desktop runtime ·{" "}
          <a href={`${SITE_ORIGIN}/download`} style={{ color: "#e0b35a" }}>updates</a>
        </p>
      </header>

      <div className="banner">
        <strong>Testnet only.</strong> Unsigned build. No mainnet calls. Wallet actions open {SITE_ORIGIN} in your browser.
      </div>

      <div className="panel">
        <strong>Link this computer</strong>
        {approvalValid(approval) ? (
          <p className="muted" style={{ margin: "0.4rem 0" }}>
            Linked: card #{approval.tokenId} · {approval.wallet.slice(0, 6)}…{approval.wallet.slice(-4)} ·{" "}
            {Math.max(0, Math.round((approval.expires - Date.now() / 1000) / 86400))} days left. Batches are signed automatically.
          </p>
        ) : (
          <p className="muted" style={{ margin: "0.4rem 0" }}>
            Approve this computer once (7 days) so batches send without a wallet prompt every 10 minutes and your card shows
            Running live.
          </p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn-outline" onClick={() => void openUrl(linkUrl(selectedId))}>
            {approvalValid(approval) ? "Link again" : "Link with your wallet"}
          </button>
          {approval && (
            <button type="button" className="btn-outline" onClick={() => { unlink(); setApproval(null); }}>Unlink</button>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <input value={linkCode} onChange={(e) => setLinkCode(e.target.value)} placeholder="…or paste the approval code"
            style={{ flex: 1, minWidth: 0, padding: "0.5rem", borderRadius: 8, background: "#0b0906", color: "inherit", border: "1px solid rgba(224,179,90,0.35)" }} />
          <button type="button" className="btn-outline" disabled={!linkCode.trim()} onClick={() => void useLinkCode(linkCode)}>Use code</button>
        </div>
        {liveMsg && <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>{liveMsg}</p>}
      </div>

      <div className="panel">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn-gold" onClick={() => void openWalletConnect()}>
            {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect wallet"}
          </button>
          {selected && !selected.stakedByWallet && (
            <>
              <button type="button" className="btn-outline" onClick={() => setProfilePickerOpen(true)}>
                {profilePick ? "Profile ✓" : "Choose profile"}
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() =>
                  void openStakeFlow(
                    selected.tokenId,
                    profilePick?.museId ? String(profilePick.museId) : undefined
                  )
                }
              >
                Stake in browser
              </button>
            </>
          )}
        </div>
        {tokensError ? (
          <div style={{ marginTop: "0.75rem" }}>
            <p className="muted" style={{ color: "#fca5a5" }}>{tokensError}</p>
            <button type="button" className="btn-outline" style={{ marginTop: 8, width: "100%" }} onClick={() => void refreshTokens()}>
              Retry
            </button>
          </div>
        ) : tokensLoading && wallet ? (
          <p className="muted" style={{ marginTop: "0.75rem" }}>Loading your nodes…</p>
        ) : tokens.length === 0 && wallet ? (
          <p className="muted" style={{ marginTop: "0.75rem" }}>No Genesis bonds for this wallet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "0.75rem 0 0" }}>
            {tokens.map((t) => (
              <li key={t.tokenId} style={{ marginBottom: "0.5rem" }}>
                <button
                  type="button"
                  className="btn-outline"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    borderColor: selectedId === t.tokenId ? "#e0b35a" : undefined,
                  }}
                  onClick={() => setSelectedId(t.tokenId)}
                >
                  #{t.tokenId} · {t.tier} · {t.stakedByWallet ? "staked" : "wallet"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <>
          <LiveCard id={selected.tokenId} localRunning={running} localRate={checksPerSec} />
          <p className="muted" style={{ textAlign: "center", margin: 0 }}>{selected.name} — {selected.status}</p>
        </>
      )}

      <div className="stat-grid">
        <div className="stat"><label>Checks/s</label><span>{checksPerSec.toFixed(1)}</span></div>
        <div className="stat"><label>Elapsed</label><span>{elapsedSec.toFixed(0)}s</span></div>
        <div className="stat"><label>Heat ×</label><span>{heatSlowdown.toFixed(2)}</span></div>
        <div className="stat"><label>Checks</label><span>{checks}</span></div>
        {points && (
          <>
            <div className="stat"><label>Today</label><span>{points.checksToday.toString()}</span></div>
            <div className="stat"><label>Points</label><span>{points.totalPoints.toString()}</span></div>
          </>
        )}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.75rem" }}>
        Points credit on-chain about every 15 minutes.
      </p>
      <p className="muted" style={{ margin: 0, fontFamily: "monospace", fontSize: "0.7rem" }}>hash {resultHash || "—"}</p>

      <button
        type="button"
        className="btn-gold"
        style={{ width: "100%", fontSize: "1.1rem" }}
        disabled={!staked && !running}
        onClick={() => (running ? stopRun() : startRun())}
      >
        {running ? "Stop node" : "Start node"}
      </button>

      {heatThrottle && (
        <div className="banner" style={{ borderColor: "rgba(251, 191, 36, 0.4)" }}>
          <strong>Heat throttle.</strong> Checks stayed much slower for 2 minutes, so the node paused to let your computer cool. Press Start to try again, or tick the override below.
        </div>
      )}

      <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={throttleOverride}
          onChange={(e) => setThrottleOverride(e.target.checked)}
        />
        Override heat / battery throttle
      </label>

      <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={autostart}
          onChange={async (e) => {
            const on = e.target.checked;
            if (on) await enable();
            else await disable();
            setAutostart(on);
          }}
        />
        Run on system startup
      </label>

      {wallet && selectedId ? (
        <ProfilePicturePicker
          open={profilePickerOpen}
          onClose={() => setProfilePickerOpen(false)}
          wallet={wallet}
          bondTokenId={selectedId}
          value={profilePick}
          onSelect={(pick) => {
            setProfilePick(pick);
            saveProfilePick(wallet, selectedId, pick);
          }}
        />
      ) : null}

      {status && <p className="muted">{status}</p>}

      <LocalModels approval={approval} />

      <ValidatorPanel />
    </div>
  );
}
