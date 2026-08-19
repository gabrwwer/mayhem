import "../styles/sidebar.css";

export type PageType = "TERMINAL" | "POSITIONS" | "HISTORY" | "CONFIG" | "TOKENS";

interface SidebarProps {
  activePage: PageType;
  onPageChange: (page: PageType) => void;
  positionCount?: number;
}

interface NavItem {
  id: PageType;
  label: string;
  icon: string;
  badge?: string | number;
}

const navItems: NavItem[] = [
  { id: "TERMINAL", label: "TERMINAL", icon: "📊" },
  { id: "TOKENS", label: "TOKENS", icon: "🔎" },
  { id: "POSITIONS", label: "POSITIONS", icon: "💰" },
  { id: "HISTORY", label: "HISTORY", icon: "📜" },
  { id: "CONFIG", label: "CONFIG", icon: "⚙️" },
];

export default function Sidebar({ activePage, onPageChange, positionCount }: SidebarProps) {
  const itemsWithBadges = navItems.map((item) => ({
    ...item,
    badge:
      item.id === "POSITIONS" && positionCount ? positionCount : item.badge,
  }));

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title">MAYHEM</h1>
        <p className="sidebar-subtitle">TRADING TERMINAL</p>
      </div>

      <div className="sidebar-nav">
        {itemsWithBadges.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${activePage === item.id ? "active" : ""}`}
            onClick={() => onPageChange(item.id)}
            title={item.label}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <p className="version">v1.0.0</p>
      </div>
    </nav>
  );
}
