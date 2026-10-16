import { formatUnits, parseUnits } from "viem";

/** Every number carries its unit and is set in mono: 1,250.00 NRX. */
export function fmt(v: bigint | undefined | null, decimals = 6, dp = 2): string {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtAmt(v: bigint | undefined | null, unit: string, decimals = 6, dp = 2) {
  return v === undefined || v === null ? "—" : `${fmt(v, decimals, dp)} ${unit}`;
}
export function fmtNum(n: number | undefined | null, dp = 2) {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function pct(n: number | undefined | null, dp = 2) {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(dp)}%`;
}
export function short(a?: string, n = 4) {
  if (!a) return "—";
  return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}
export function parseAmount(s: string, decimals = 6): bigint | undefined {
  if (!s || !/^\d*\.?\d*$/.test(s) || s === ".") return undefined;
  try {
    return parseUnits(s, decimals);
  } catch {
    return undefined;
  }
}
export function ago(ms?: number) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function duration(ms?: number | null) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
export const WAD = 10n ** 18n;
