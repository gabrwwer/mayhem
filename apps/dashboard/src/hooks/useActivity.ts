import { useCallback, useRef, useState } from "react";
import type { ActivityEntry, ActivityType } from "../types/trading";

const MAX_ENTRIES = 50;

export function useActivity(limit = MAX_ENTRIES) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const counter = useRef(0);

  const addEntry = useCallback(
    (message: string, type: ActivityType = "INFO") => {
      counter.current += 1;
      const entry: ActivityEntry = {
        id: `${Date.now()}-${counter.current}`,
        timestamp: Date.now(),
        message,
        type,
      };
      setEntries((current) => [entry, ...current].slice(0, limit));
    },
    [limit],
  );

  return { entries, addEntry };
}