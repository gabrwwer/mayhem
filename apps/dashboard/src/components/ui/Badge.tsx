import type { ReactNode } from "react";

/**
 * Semantic tones. Colour in this application always means something:
 *   ok/safe = positive, bad/danger = negative, warn = caution,
 *   info = live/informational, primary = selected/active,
 *   sim = simulated (dry run), muted = no signal.
 */
export type Tone =
  | "ok"
  | "safe"
  | "bad"
  | "danger"
  | "warn"
  | "info"
  | "primary"
  | "sim"
  | "muted"
  | "neutral";

interface BadgeProps {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}

export function Badge({ tone = "neutral", title, children }: BadgeProps) {
  return (
    <span className="mh-badge" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

interface DotProps {
  tone?: Tone;
  /** Pulse to indicate a live stream. Suppressed under prefers-reduced-motion. */
  live?: boolean;
  title?: string;
}

export function Dot({ tone = "neutral", live = false, title }: DotProps) {
  return (
    <span
      className="mh-dot"
      data-tone={tone}
      data-live={live ? "true" : undefined}
      title={title}
      aria-hidden="true"
    />
  );
}
