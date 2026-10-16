"use client";
import { useEffect, type ReactNode } from "react";
import type { TxState } from "@/lib/tx";
import { fmt } from "@/lib/format";

export function PageHead({ title, sub, chainNote }: { title: string; sub?: ReactNode; chainNote?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {sub && <p className="muted">{sub}</p>}
      {chainNote && <p className="chain-note">{chainNote}</p>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "signal" | "yield" | "danger" | "brand" }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`num ${tone ?? ""}`}>{value}</span>
      {sub && <span className="small">{sub}</span>}
    </div>
  );
}

export function Kv({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: string }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span className={`mono ${tone ?? ""}`}>{v}</span>
    </div>
  );
}

export function Notice({ tone, children, icon }: { tone?: "danger" | "yield" | "brand"; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={`notice ${tone ? `notice-${tone}` : ""}`} role={tone === "danger" ? "alert" : undefined}>
      {icon ?? (tone === "danger" ? <WarnIcon /> : <InfoIcon />)}
      <div>{children}</div>
    </div>
  );
}

export function AmountInput({
  value, onChange, unit, max, maxDecimals = 6, label, id, disabled,
}: { value: string; onChange: (v: string) => void; unit: string; max?: bigint; maxDecimals?: number; label: string; id: string; disabled?: boolean }) {
  return (
    <div className="field">
      <div className="between">
        <label htmlFor={id}>{label}</label>
        {max !== undefined && (
          <span className="small">
            Available <span className="mono">{fmt(max, maxDecimals, maxDecimals > 6 ? 4 : 2)} {unit}</span>
          </span>
        )}
      </div>
      <div className="amount">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value.replace(",", ".");
            if (/^\d*\.?\d*$/.test(v)) onChange(v);
          }}
        />
        <span className="unit">
          {max !== undefined && (
            <button type="button" className="max" onClick={() => onChange(trimUnits(max, maxDecimals))}>
              Max
            </button>
          )}
          {unit}
        </span>
      </div>
    </div>
  );
}

function trimUnits(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** One primary button per view. Shows the reason when disabled. */
export function ActionButton({ children, onClick, disabled, reason, busy, variant = "primary" }: { children: ReactNode; onClick: () => void; disabled?: boolean; reason?: string | false | null; busy?: boolean; variant?: "primary" | "secondary" | "danger" }) {
  const cls = variant === "primary" ? "btn btn-primary btn-block" : variant === "danger" ? "btn btn-danger btn-block" : "btn btn-block";
  return (
    <div className="stack-1">
      <button className={cls} onClick={onClick} disabled={disabled || busy || Boolean(reason)} aria-busy={busy}>
        {busy && <span className="dot live" aria-hidden />}
        {children}
      </button>
      {reason && <span className="small">{reason}</span>}
    </div>
  );
}

export function TxStatus({ state }: { state: TxState }) {
  if (state.busy)
    return (
      <div className="row small" aria-live="polite">
        <span className="dot live" aria-hidden />
        <span>
          {state.total > 1 && <span className="mono">Step {Math.max(state.step, 1)} of {state.total} · </span>}
          {state.label}…
        </span>
      </div>
    );
  if (state.error) return <Notice tone="danger"><strong>Not sent.</strong> {state.error}</Notice>;
  if (state.done)
    return (
      <div className="row small signal" aria-live="polite">
        <CheckIcon /> <span>{state.done}</span>
      </div>
    );
  return null;
}

export function Modal({ open, onClose, title, children, dismissable = true }: { open: boolean; onClose: () => void; title: string; children: ReactNode; dismissable?: boolean }) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return (
    <div className="overlay" onClick={() => dismissable && onClose()}>
      <div className="modal stack" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2>{title}</h2>
          {dismissable && (
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.id} className="tab" role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Bar({ value, tone }: { value: number; tone?: "yield" | "danger" }) {
  return (
    <div className={`bar ${tone ?? ""}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

export function PausedNotice({ what }: { what: string }) {
  return (
    <Notice tone="danger">
      <strong>Contract paused.</strong> {what} is paused by the guardian. Writes are disabled until it resumes.
    </Notice>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ------------------------------------------------------------------ icons (1.5px outline)

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "none", marginTop: 2 }}>
    {children}
  </svg>
);
export const InfoIcon = () => <I><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></I>;
export const WarnIcon = () => <I><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></I>;
export const CheckIcon = () => <I><path d="m5 12 4 4 10-10" /></I>;
export const CloseIcon = () => <I><path d="M6 6l12 12M18 6 6 18" /></I>;
export const MenuIcon = () => <I size={20}><path d="M4 7h16M4 12h16M4 17h16" /></I>;
export const ArrowIcon = () => <I><path d="M5 12h14M13 6l6 6-6 6" /></I>;
export const ExternalIcon = () => <I><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></I>;
export const SunIcon = () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>;
export const CopyIcon = () => <I><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></I>;
