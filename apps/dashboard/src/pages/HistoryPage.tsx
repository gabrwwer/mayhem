import type { ActivityEntry } from "../types/trading";
import ActivityFeed from "../components/ActivityFeed";
import OrderHistory from "../components/OrderHistory";
import "../styles/history.css";

interface HistoryPageProps {
  entries: ActivityEntry[];
}

export default function HistoryPage({ entries }: HistoryPageProps) {
  return (
    <div className="history-page">
      <div className="history-grid">
        <OrderHistory />
        <ActivityFeed entries={entries} />
      </div>
    </div>
  );
}
