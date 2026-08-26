import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/client';
import { WsClient } from '../api/ws';

import type {
  Position,
  WsMessage,
} from '../app/type';

const POSITION_EPSILON = 1e-9;

/**
 * Positions hook.
 *
 * Provides:
 * - REST position snapshot
 * - live WebSocket position reconciliation
 * - position filtering by coin
 * - reduce-only market close
 * - manual refresh
 */
export function usePositions(coin?: string) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);

  const wsRef = useRef<WsClient | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);

      const list = await api.getPositions();

      setPositions(Array.isArray(list) ? list : []);
    } catch {
      // Keep the last known position state on transient API failure.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const ws = new WsClient();

    wsRef.current = ws;

    void refresh();

    ws.connect();

    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      if (!mounted) {
        return;
      }

      if (msg.channel !== 'positions') {
        return;
      }

      const position = msg.data as Position;

      if (!position?.coin) {
        return;
      }

      setPositions((previous) => {
        const remaining = previous.filter(
          (existing) => existing.coin !== position.coin,
        );

        // A zero-sized position represents a closed position.
        if (Math.abs(position.size) < POSITION_EPSILON) {
          return remaining;
        }

        return [position, ...remaining];
      });
    });

    return () => {
      mounted = false;

      unsubscribe();
      ws.close();

      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [refresh]);

  /**
   * Close an existing position using a reduce-only market order.
   */
  const closePosition = useCallback(
    async (targetCoin: string) => {
      const position = positions.find(
        (candidate) => candidate.coin === targetCoin,
      );

      if (!position) {
        return;
      }

      if (
        !Number.isFinite(position.size) ||
        Math.abs(position.size) < POSITION_EPSILON
      ) {
        return;
      }

      try {
        await api.placeOrder({
          coin: targetCoin,
          side: position.side === 'buy' ? 'sell' : 'buy',
          type: 'market',
          size: Math.abs(position.size),
          reduceOnly: true,
        });
      } finally {
        await refresh();
      }
    },
    [positions, refresh],
  );

  const visiblePositions = coin
    ? positions.filter((position) => position.coin === coin)
    : positions;

  return {
    positions: visiblePositions,
    loading,
    closePosition,
    refresh,
  };
}