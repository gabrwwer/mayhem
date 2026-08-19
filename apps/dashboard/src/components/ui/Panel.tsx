import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  /** Right-aligned metadata in the panel header (counts, timestamps, tone chips). */
  meta?: ReactNode;
  /** Header controls rendered after the title, before the meta slot. */
  actions?: ReactNode;
  /** Apply body padding. Off for tables, which manage their own spacing. */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Standard panel chrome: uppercase title bar, thin border, no radius to speak
 * of. Body scrolls independently so a dense dashboard never scrolls as a whole.
 */
export default function Panel({
  title,
  meta,
  actions,
  padded = false,
  className,
  children,
}: PanelProps) {
  return (
    <section className={`mh-panel${className ? ` ${className}` : ""}`}>
      <header className="mh-panel__head">
        <span className="mh-panel__title">{title}</span>
        {actions}
        {meta ? <span className="mh-panel__meta">{meta}</span> : null}
      </header>
      <div className={`mh-panel__body${padded ? " mh-panel__body--pad" : ""}`}>
        {children}
      </div>
    </section>
  );
}
