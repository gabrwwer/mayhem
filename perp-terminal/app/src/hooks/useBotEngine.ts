import { useCallback, useEffect, useRef, useState } from 'react';
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
 * Mayhem / Anarchy bot controls:
 * - configuration
 * - start / stop
 * - panic flatten
 * - WebSocket state updates
 * - REST polling fallback
 */
export function useBotEngine(coin: string) {
  const [config, setConfig] = useState<BotConfig>(() => ({
    ...DEFAULT_BOT_CONFIG,
    coin,
  }));

  const [state, setState] = useState<BotState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WsClient | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const nextState = await api.getBotState();
      setState(nextState);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const nextConfig = await api.getBotConfig();

      setConfig({
        ...nextConfig,
        coin,
      });

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [coin]);

  useEffect(() => {
    let mounted = true;

    const ws = new WsClient();
    wsRef.current = ws;

    void refreshConfig();
    void refreshState();

    const timer = window.setInterval(() => {
      if (mounted) {
        void refreshState();
      }
    }, STATE_POLL_MS);

    ws.connect();

    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      if (!mounted) return;

      if (msg.channel === 'bot') {
        setState(msg.data as BotState);
      }
    });

    return () => {
      mounted = false;
      window.clearInterval(timer);
      unsubscribe();
      ws.close();

      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [refreshConfig, refreshState]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
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
    },
    [],
  );

  const updateConfig = useCallback(
    (patch: Partial<BotConfig>) => {
      const nextPatch: Partial<BotConfig> = {
        ...patch,
        ...(patch.coin === undefined ? { coin } : {}),
      };

      setConfig((prev) => ({
        ...prev,
        ...nextPatch,
      }));

      void run(() => api.setBotConfig(nextPatch)).then((result) => {
        if (result !== undefined) {
          void refreshConfig();
        }
      });
    },
    [coin, refreshConfig, run],
  );

  const toggle = useCallback(() => {
    const shouldStart = !(state?.running ?? false);

    setConfig((prev) => ({
      ...prev,
      enabled: shouldStart,
      coin,
    }));

    void run(() =>
      shouldStart ? api.startBot() : api.stopBot(),
    ).then((nextState) => {
      if (nextState !== undefined) {
        setState(nextState);
      }

      void refreshConfig();
      void refreshState();
    });
  }, [coin, refreshConfig, refreshState, run, state?.running]);

  const panic = useCallback(() => {
    void run(async () => {
      const res = await api.panic();

      setState((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              lastAction: `Panic: flattened ${res.closed} position(s)`,
            }
          : prev,
      );

      void refreshConfig();
      void refreshState();
    });
  }, [refreshConfig, refreshState, run]);

  const setMode = useCallback(
    (mode: BotMode) => {
      updateConfig({ mode });
    },
    [updateConfig],
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