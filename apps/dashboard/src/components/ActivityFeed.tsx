import { formatTime } from "../lib/format";
import type { ActivityEntry, ActivityType } from "../types/trading";

const TYPE_CLASS: Record<ActivityType, string> = {
  INFO: "t-info",
  SUCCESS: "t-success",
  WARNING: "t-warning",
  ERROR: "t-error",
  TRADE: "t-trade",
  SYSTEM: "t-system",
};

export interface ActivityFeedProps {
  entries: ActivityEntry[];
}

export default function ActivityFeed({ entries }: ActivityFeedProps) {
  return (
    <section className="panel activity-panel">
      <div className="panel-header">
        <div>
          <span className="panel-kicker">LIVE FEED</span>
          <h2>ACTIVITY</h2>
        </div>
        <span className="live-indicator">TERMINAL</span>
      </div>

      <div className="activity-list" aria-live="polite">
        {entries.length === 0 ? (
          <div className="activity-empty">
            NO ACTIVITY — SYSTEM IDLE
          </div>
        ) : (
          entries.map((entry) => (
            <div
              className={`activity-entry ${TYPE_CLASS[entry.type]}`}
              key={entry.id}
            >
              <span className="activity-time">{formatTime(entry.timestamp)}</span>
              <span className="activity-type">{entry.type}</span>
              <span className="activity-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}