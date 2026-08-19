
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { WsClient } from '../api/ws';
import type { Position, WsMessage } from '../app/type';

/** Positions: REST snapshot + live WS reconciliation + close helper. */
export function usePositions(coin?: string) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [ws] = useState(() => new WsClient());

  const refresh = useCallback(async () => {
    try {
      const list = await api.getPositions();
      setPositions(Array.isArray(list) ? list : []);
    } catch {
      /* keep last known state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    ws.connect();
    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      if (msg.channel !== 'positions') return;
      const p = msg.data as Position;
      if (!p?.coin) return;
      setPositions((prev) => {
        const rest = prev.filter((x) => x.coin !== p.coin);
        if (Math.abs(p.size) < 1e-9) return rest; // closed -> remove
        return [p, ...rest];
      });
    });
    return () => {
      unsubscribe();
      ws.close();
    };
  }, [refresh, ws]);

  const closePosition = useCallback(
    async (c: string) => {
      const pos = positions.find((p) => p.coin === c);
      if (!pos) return;
      await api
        .placeOrder({
          coin: c,
          side: pos.side === 'buy' ? 'sell' : 'buy',
          type: 'market',
          size: pos.size,
          reduceOnly: true,
        })
        .catch(() => {});
      void refresh();
    },
    [positions, refresh]
  );

  const visible = coin ? positions.filter((p) => p.coin === coin) : positions;

  return { positions: visible, loading, closePosition, refresh };
}