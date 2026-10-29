export const LOW_BATTERY_FRACTION = 0.3;

export type BatterySnapshot = {
  level: number;
  charging: boolean;
};

export type BatteryGateStatus = "unsupported" | "pending" | "ready";

/** Normalize Battery API level (0–1). Rejects out-of-range or non-finite values. */
export function normalizeBatteryLevel(level: unknown): number | null {
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  if (level < 0 || level > 1) return null;
  return level;
}

export function shouldPauseForBattery(level: number, charging: boolean, override: boolean): boolean {
  if (override) return false;
  return level < LOW_BATTERY_FRACTION && !charging;
}

/** True when worker must not run (low battery or still waiting for first reading). */
export function isBatteryRunBlocked(
  status: BatteryGateStatus,
  snapshot: BatterySnapshot | null,
  override: boolean
): boolean {
  if (override) return false;
  if (status === "pending") return true;
  if (status !== "ready" || !snapshot) return false;
  return shouldPauseForBattery(snapshot.level, snapshot.charging, false);
}

export function batteryGateLabel(
  status: BatteryGateStatus,
  snapshot: BatterySnapshot | null,
  override: boolean,
  running: boolean
): string {
  if (isBatteryRunBlocked(status, snapshot, override)) return "Paused (battery)";
  if (running) return "Stop";
  return "Start";
}
