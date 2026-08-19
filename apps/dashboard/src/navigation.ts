/**
 * Canonical section registry.
 *
 * Single source of truth for routes, rail order and page titles. Adding a
 * section means adding one entry here — the router, the rail and the page
 * header all read from this list, so they cannot drift apart.
 */

export interface NavSection {
  /** URL path, without leading slash for children of "/". */
  path: string;
  /** Rail + page header label. */
  label: string;
  /** One-line description shown in the page sub-header. */
  description: string;
  /** Rail grouping. */
  group: NavGroup;
}

export type NavGroup = "OPERATIONS" | "MARKET" | "PORTFOLIO" | "CONTROL";

export const NAV_GROUPS: NavGroup[] = [
  "OPERATIONS",
  "MARKET",
  "PORTFOLIO",
  "CONTROL",
];

export const SECTIONS: NavSection[] = [
  {
    path: "/",
    label: "Dashboard",
    description: "Consolidated operating picture",
    group: "OPERATIONS",
  },
  {
    path: "/activity",
    label: "Activity",
    description: "Chronological engine event stream",
    group: "OPERATIONS",
  },
  {
    path: "/system",
    label: "System",
    description: "Component health, latency and throughput",
    group: "OPERATIONS",
  },
  {
    path: "/alerts",
    label: "Alerts",
    description: "Signal, risk and execution events requiring attention",
    group: "OPERATIONS",
  },

  {
    path: "/discover",
    label: "Discover",
    description: "Token scanner over the discovery feed",
    group: "MARKET",
  },
  {
    path: "/markets",
    label: "Markets",
    description: "Tracked market overview",
    group: "MARKET",
  },
  {
    path: "/token",
    label: "Intelligence",
    description: "Per-token detail terminal",
    group: "MARKET",
  },

  {
    path: "/positions",
    label: "Positions",
    description: "Open position management",
    group: "PORTFOLIO",
  },
  {
    path: "/trades",
    label: "Trades",
    description: "Executed trade history",
    group: "PORTFOLIO",
  },
  {
    path: "/portfolio",
    label: "Portfolio",
    description: "Balances, equity and realised performance",
    group: "PORTFOLIO",
  },
  {
    path: "/risk",
    label: "Risk",
    description: "Limits, utilisation and circuit breakers",
    group: "PORTFOLIO",
  },

  {
    path: "/config",
    label: "Config",
    description: "Bot configuration (.env-backed)",
    group: "CONTROL",
  },
  {
    path: "/settings",
    label: "Settings",
    description: "Terminal preferences (stored locally)",
    group: "CONTROL",
  },
];

export function sectionForPath(pathname: string): NavSection | undefined {
  if (pathname === "/") {
    return SECTIONS.find((s) => s.path === "/");
  }
  // Longest prefix wins so /token/<mint> resolves to the /token section.
  return SECTIONS.filter((s) => s.path !== "/")
    .filter((s) => pathname === s.path || pathname.startsWith(`${s.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
