import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { sectionForPath } from "../../navigation";

interface PageFrameProps {
  /** Header controls for this section (filters, refresh, actions). */
  actions?: ReactNode;
  /** Right-aligned status text, e.g. row counts or last-updated. */
  meta?: ReactNode;
  /** Remove body padding for full-bleed tables. */
  flush?: boolean;
  children: ReactNode;
}

/**
 * Section chrome. Title and description come from the navigation registry so
 * the page header can never disagree with the rail.
 */
export default function PageFrame({
  actions,
  meta,
  flush = false,
  children,
}: PageFrameProps) {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);

  return (
    <div className="mh-page">
      <div className="mh-page__head">
        <span className="mh-page__title">{section?.label ?? "MAYHEM"}</span>
        <span className="mh-page__sub">{section?.description ?? ""}</span>
        {actions ? <div className="mh-row">{actions}</div> : null}
        {meta ? (
          <div className="mh-page__sub" style={{ marginLeft: "auto" }}>
            {meta}
          </div>
        ) : null}
      </div>
      <div className={`mh-page__body${flush ? " mh-page__body--flush" : ""}`}>
        {children}
      </div>
    </div>
  );
}
