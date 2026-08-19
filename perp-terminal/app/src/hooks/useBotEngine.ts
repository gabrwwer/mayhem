
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { WsClient } from '../api/ws';
import type { BotConfig, BotMode, BotState, WsMessage } from '../app/type';

export const DEFAULT_BOT_CONFIG: BotConfig = {
  mode: 'mayhem',
  enabled: false,
  coin: 'BTC',
  aggressiveness: 0.5,
  maxOrderSize: 0.01,
  minOrderSize: 0.001,
  orderRateLimit: 2000,
  useMarketOrders: false,
  takeProfitPct: 2,
  stopLossPct: 1.5,
  maxOpenPositions: 3,
  followTrend: true,
};

const STATE_POLL_MS = 3000;

/**
 * Mayhem / Anarchy bot controls: config CRUD, start/stop, panic flatten.
 * State is kept fresh by WS pushes + a slow REST poll as fallback.
 */
export function useBotEngine(coin: string) {
  const [config, setConfig] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const [state, setState] = useState<BotState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ws] = useState(() => new WsClient());

  const refreshState = useCallback(async () => {
    try {
      setState(await api.getBotState());
    } catch {
      /* backend may be offline */
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.getBotConfig());
    } catch {
      /* backend may be offline */
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
    void refreshState();
    const timer = window.setInterval(() => void refreshState(), STATE_POLL_MS);
    ws.connect();
    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      if (msg.channel === 'bot') setState(msg.data as BotState);
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      ws.close();
    };
  }, [refreshConfig, refreshState, ws]);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const updateConfig = useCallback(
    (patch: Partial<BotConfig>) => {
      setConfig((prev) => ({ ...prev, ...patch }));
      void run(() => api.setBotConfig(patch)).then(() => void refreshConfig());
    },
    [run, refreshConfig]
  );

  const toggle = useCallback(() => {
    const shouldStart = !state?.running;
    setConfig((prev) => ({ ...prev, enabled: shouldStart }));
    void run(() => (shouldStart ? api.startBot() : api.stopBot())).then((s) => {
      if (s) setState(s);
      void refreshConfig();
    });
  }, [state, run, refreshConfig]);

  const panic = useCallback(() => {
    void run(async () => {
      const res = await api.panic();
      setState((prev) =>
        prev
          ? { ...prev, running: false, lastAction: `Panic: flattened ${res.closed} position(s)` }
          : prev
      );
      void refreshConfig();
    });
  }, [run, refreshConfig]);

  const setMode = useCallback(
    (mode: BotMode) => updateConfig({ mode }),
    [updateConfig]
  );

  const refresh = useCallback(() => {
    void refreshState();
    void refreshConfig();
  }, [refreshConfig, refreshState]);

  return {
    config,
    state,
    busy,
    error,
    updateConfig,
    toggle,
    panic,
    setMode,
    refresh,
  };
}