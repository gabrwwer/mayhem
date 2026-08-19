import type { ReactNode } from "react";

/**
 * Data-integrity primitives.
 *
 * The rule this file exists to enforce: the UI never shows a number the
 * backend did not supply. When a value is missing we say so, and we name the
 * data source that would provide it — so a gap reads as a known gap rather
 * than as a bug or, worse, as a real reading of zero.
 *
 * Never substitute 0, "—", or a plausible-looking placeholder for missing data.
 */

interface UnavailableProps {
  /** What would supply this value, e.g. "GET /api/risk". Shown on hover. */
  source?: string;
  /** Short reason, e.g. "not implemented", "bot has not reported yet". */
  reason?: string;
}

/** Inline stand-in for a single missing value. Renders `N/A`. */
export function Unavailable({ source, reason }: UnavailableProps) {
  const title = [
    "Not available from the backend.",
    reason ? `Reason: ${reason}` : null,
    source ? `Required source: ${source}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className="mh-na" title={title}>
      N/A
    </span>
  );
}

/**
 * Renders `value` when it is a real number, otherwise `Unavailable`.
 * `null`, `undefined` and non-finite values are all treated as missing.
 */
export function Value({
  value,
  format,
  source,
  reason,
}: {
  value: number | null | undefined;
  format: (n: number) => string;
  source?: string;
  reason?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <Unavailable source={source} reason={reason} />;
  }
  return <>{format(value)}</>;
}

interface EmptyStateProps {
  title: string;
  detail?: string;
  /** Endpoint or feed this panel reads from. Always state it. */
  source?: string;
  children?: ReactNode;
}

/** Panel-level "there is genuinely nothing here yet" state. */
export function EmptyState({ title, detail, source, children }: EmptyStateProps) {
  return (
    <div className="mh-empty">
      <span className="mh-empty__title">{title}</span>
      {detail ? <span className="mh-empty__detail">{detail}</span> : null}
      {source ? <span className="mh-empty__source">source: {source}</span> : null}
      {children}
    </div>
  );
}

/** Panel-level "this feature has no backend yet" state. Not an error. */
export function NotWired({
  what,
  needs,
}: {
  what: string;
  needs: string;
}) {
  return (
    <div className="mh-empty">
      <span className="mh-empty__title">{what} unavailable</span>
      <span className="mh-empty__detail">
        No backend data source is wired for this panel, so nothing is displayed
        rather than showing placeholder values.
      </span>
      <span className="mh-empty__source">requires: {needs}</span>
    </div>
  );
}

export function LoadingState({ what = "data" }: { what?: string }) {
  return (
    <div className="mh-empty">
      <span className="mh-empty__title">Loading {what}…</span>
    </div>
  );
}

export function ErrorState({
  message,
  source,
  onRetry,
}: {
  message: string;
  source?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="mh-empty">
      <span className="mh-empty__title mh-neg">Request failed</span>
      <span className="mh-empty__detail">{message}</span>
      {source ? <span className="mh-empty__source">source: {source}</span> : null}
      {onRetry ? (
        <button type="button" className="mh-btn mh-btn--sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Convenience wrapper for the loading -> error -> empty -> content sequence
 * every data panel needs. Keeps the four states consistent across the app.
 */
export function AsyncPanelBody<T>({
  loading,
  error,
  data,
  source,
  emptyTitle,
  emptyDetail,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  data: T[] | null;
  source: string;
  emptyTitle: string;
  emptyDetail?: string;
  onRetry?: () => void;
  children: (rows: T[]) => ReactNode;
}) {
  if (error) {
    return <ErrorState message={error} source={source} {...(onRetry ? { onRetry } : {})} />;
  }
  if (loading && (data === null || data.length === 0)) {
    return <LoadingState />;
  }
  if (data === null || data.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        source={source}
        {...(emptyDetail ? { detail: emptyDetail } : {})}
      />
    );
  }
  return <>{children(data)}</>;
}
