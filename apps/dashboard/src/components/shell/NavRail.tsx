import { NavLink } from "react-router-dom";
import { NAV_GROUPS, SECTIONS } from "../../navigation";

interface NavRailProps {
  /** Per-section badge counts, keyed by section path. Omit for no badge. */
  badges?: Partial<Record<string, number>>;
  version: string;
}

/**
 * Persistent left navigation. Uses NavLink so the active section is derived
 * from the URL rather than tracked separately — the rail cannot disagree with
 * what is rendered.
 */
export default function NavRail({ badges = {}, version }: NavRailProps) {
  return (
    <nav className="mh-rail" aria-label="Sections">
      {NAV_GROUPS.map((group) => {
        const items = SECTIONS.filter((s) => s.group === group);
        if (items.length === 0) return null;

        return (
          <div className="mh-rail__group" key={group}>
            <div className="mh-rail__grouplabel">{group}</div>
            {items.map((section) => {
              const badge = badges[section.path];

              return (
                <NavLink
                  key={section.path}
                  to={section.path}
                  end={section.path === "/"}
                  className="mh-navitem"
                  title={section.description}
                >
                  <span className="mh-navitem__key" aria-hidden="true">
                    ▸
                  </span>
                  <span className="mh-navitem__label">{section.label}</span>
                  {badge !== undefined && badge > 0 ? (
                    <span className="mh-navitem__badge">{badge}</span>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
        );
      })}

      <div className="mh-rail__foot">
        <span>MAYHEM</span>
        <span>v{version}</span>
      </div>
    </nav>
  );
}
