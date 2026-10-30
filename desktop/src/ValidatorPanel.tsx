import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registerUrl, validatePass, validatorAddress, validatorStatus, type ValidatorStatus } from "./node/validator";

const ON = "delphi-desktop-validator-on";
const EVERY_MS = 60_000;

/**
 * Validator mode: this computer re-checks other nodes' work and co-signs the batches that hold up. Validators share
 * 10% of every epoch's rewards, by batches co-signed (at least 80% of the epoch's batches to qualify).
 */
export default function ValidatorPanel() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(ON) === "1"; } catch { return false; } });
  const [st, setSt] = useState<ValidatorStatus | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [totals, setTotals] = useState({ signed: 0, refused: 0 });
  const busy = useRef(false);
  const addr = validatorAddress();

  const refresh = useCallback(() => void validatorStatus().then(setSt).catch(() => undefined), []);
  const pass = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await validatePass();
      setTotals((t) => ({ signed: t.signed + r.signed, refused: t.refused + r.refused }));
      if (r.log.length) setLog((l) => [...r.log.map((x) => `${new Date().toLocaleTimeString()} ${x}`), ...l].slice(0, 30));
    } catch (e) {
      setLog((l) => [`${new Date().toLocaleTimeString()} ${e instanceof Error ? e.message : String(e)}`, ...l].slice(0, 30));
    } finally {
      busy.current = false;
      refresh();
    }
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    try { localStorage.setItem(ON, on ? "1" : "0"); } catch { /* ignore */ }
    if (!on || !st?.registered) return;
    void pass();
    const t = setInterval(() => void pass(), EVERY_MS);
    return () => clearInterval(t);
  }, [on, st?.registered, pass]);

  const pct = st && st.epochBatches > 0 ? Math.round((100 * st.signedThisEpoch) / st.epochBatches) : null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Validator</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Re-check other nodes&apos; work and co-sign the honest batches. Validators share 10% of every week&apos;s rewards, by
        batches co-signed (at least 80% to qualify). Signing bad work can be slashed.
      </p>
      <p className="muted" style={{ wordBreak: "break-all" }}>Validator key: {addr}</p>
      {st && !st.registered ? (
        <>
          <p>Not registered yet. Bond it once from your wallet (Genesis holders: one staked card + 50,000 test mDLPH).</p>
          <button onClick={() => void openUrl(registerUrl())}>Register this computer as a validator</button>
          <button style={{ marginLeft: 8 }} onClick={refresh}>I registered: check again</button>
        </>
      ) : st ? (
        <>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
            Validate while this app is open
          </label>
          <p className="muted">
            This week: co-signed {st.signedThisEpoch} of {st.epochBatches} batches{pct != null ? ` (${pct}%${pct >= 80 ? ", qualifies" : ", needs 80%"})` : ""}
            {totals.signed + totals.refused > 0 ? ` · this session: ${totals.signed} signed, ${totals.refused} refused` : ""}
          </p>
        </>
      ) : (
        <p className="muted">Checking…</p>
      )}
      {log.length > 0 && (
        <pre style={{ fontSize: 11, maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
      )}
    </div>
  );
}
