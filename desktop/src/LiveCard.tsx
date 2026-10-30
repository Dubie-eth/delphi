import { useEffect, useState } from "react";
import { SITE_ORIGIN } from "./config";

// same colors as delphi.site (app/lib/cardStatus.ts CARD_COLORS) and the Android widget
const COLORS: Record<string, string> = {
  running: "#22c55e", idle: "#ef4444", offline: "#ef4444", slashing: "#eab308", cooling: "#9ca3af", slashed: "#b91c1c",
};
const UNKNOWN = "#6b6250";

type Stats = { state: string; label: string; points: number; rateLive: number | null; rateCredited: number; jobs?: number | null };

/**
 * The card like the home-screen widget: its PFP oracle (face, role swag, 1/1 body, drawn by delphi.site/card/<id>/pfp)
 * glowing in the live status color, with status and points. Polls the card's public stats every 20 s; while this
 * computer is running the node it shows Running right away instead of waiting for the next poll.
 */
export default function LiveCard({ id, localRunning, localRate }: { id: number; localRunning: boolean; localRate: number }) {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${SITE_ORIGIN}/api/cards/${id}/stats`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => alive && j && setS(j))
        .catch(() => {});
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, localRunning]); // re-poll right after Start/Stop
  useEffect(() => setS(null), [id]);

  const state = localRunning ? "running" : s?.state ?? "";
  const color = COLORS[state] ?? UNKNOWN;
  const label = localRunning ? "Running on this computer" : s?.label ?? "Checking…";
  const rate = localRunning ? localRate : s?.rateLive ?? null;
  const line = [rate != null && rate > 0 ? `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} c/s` : null, s ? `${s.points.toLocaleString("en-US")} pts` : null, s?.jobs != null ? `${s.jobs.toLocaleString("en-US")} jobs` : null]
    .filter(Boolean)
    .join(" · ");
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => setImgOk(true), [id, color]);

  return (
    <div className="panel" style={{ textAlign: "center", background: "#0a0a0a", borderColor: "rgba(212,175,55,.35)" }}>
      <div style={{ width: 200, height: 200, margin: "0 auto", filter: `drop-shadow(0 0 14px ${color}66)` }}>
        {imgOk ? (
          <img
            src={`${SITE_ORIGIN}/card/${id}/pfp?c=${color.slice(1)}&size=256`}
            alt={`Node #${id}: ${label}`}
            width={200}
            height={200}
            onError={() => setImgOk(false)}
          />
        ) : (
          <div style={{ width: 200, height: 200, borderRadius: "50%", background: color, opacity: 0.6 }} />
        )}
      </div>
      <div style={{ color: "#d4af37", fontFamily: "Georgia, serif", fontWeight: 700, fontSize: "1.4rem" }}>#{id}</div>
      <div style={{ color, fontSize: "1rem" }}>{label}</div>
      {line && <div style={{ color: "#b8a46a", fontSize: "0.85rem" }}>{line}</div>}
    </div>
  );
}
