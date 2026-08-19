import type { ReactNode } from "react";
import type { Tone } from "./Badge";

interface StatProps {
  label: string;
  /** Pre-formatted value, or an <Unavailable/> element. Never a fabricated 0. */
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  /** Emphasise as a headline metric. */
  large?: boolean;
  title?: string;
}

const TONE_CLASS: Partial<Record<Tone, string>> = {
  ok: "mh-pos",
  safe: "mh-pos",
  bad: "mh-neg",
  danger: "mh-neg",
  warn: "mh-warn",
  info: "mh-info",
};

export function Stat({ label, value, sub, tone, large, title }: StatProps) {
  const toneClass = tone ? (TONE_CLASS[tone] ?? "") : "";

  return (
    <div className="mh-stat" title={title}>
      <span className="mh-stat__label">{label}</span>
      <span
        className={`mh-stat__value${large ? " mh-stat__value--lg" : ""}${
          toneClass ? ` ${toneClass}` : ""
        }`}
      >
        {value}
      </span>
      {sub ? <span className="mh-stat__sub">{sub}</span> : null}
    </div>
  );
}

/** Horizontal band of stats. Used above the fold on Dashboard and Positions. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="mh-statrow">{children}</div>;
}

interface MeterProps {
  /** Current value in the same unit as `limit`. */
  current: number;
  limit: number;
  tone?: Tone;
}

/** Current-vs-limit bar. Used throughout the Risk Center. */
export function Meter({ current, limit, tone }: MeterProps) {
  const ratio = limit > 0 ? Math.min(Math.max(current / limit, 0), 1) : 0;
  const derived: Tone = tone ?? (ratio >= 0.9 ? "bad" : ratio >= 0.7 ? "warn" : "ok");

  return (
    <div
      className="mh-meter"
      role="meter"
      aria-valuenow={current}
      aria-valuemin={0}
      aria-valuemax={limit}
    >
      <div
        className="mh-meter__fill"
        data-tone={derived}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}
