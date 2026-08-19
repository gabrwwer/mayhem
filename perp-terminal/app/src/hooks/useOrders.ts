
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { WsClient } from '../api/ws';
import type { Order, OrderRequest, WsMessage } from '../app/type';

export interface OrderResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** Open orders: CRUD against REST + live reconciliation over WS. */
export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [ws] = useState(() => new WsClient());

  const refresh = useCallback(async () => {
    try {
      const list = await api.getOpenOrders();
      setOrders(Array.isArray(list) ? list : []);
    } catch {
      /* keep last known state while backend is unreachable */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    ws.connect();
    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      if (msg.channel !== 'orders') return;
      const data = msg.data as Order;
      if (!data?.id) return;
      if (data.status === 'canceled' || data.status === 'filled') {
        setOrders((prev) => prev.filter((o) => o.id !== data.id));
      } else {
        setOrders((prev) => {
          const idx = prev.findIndex((o) => o.id === data.id);
          if (idx === -1) return [data, ...prev];
          const next = [...prev];
          next[idx] = data;
          return next;
        });
      }
    });
    return () => {
      unsubscribe();
      ws.close();
    };
  }, [refresh, ws]);

  const place = useCallback(
    async (order: OrderRequest): Promise<OrderResult> => {
      setSubmitting(true);
      try {
        const { id } = await api.placeOrder(order);
        void refresh();
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        setSubmitting(false);
      }
    },
    [refresh]
  );

  const cancel = useCallback(
    async (id: string) => {
      await api.cancelOrder(id).catch(() => {});
      void refresh();
    },
    [refresh]
  );

  const cancelAll = useCallback(async () => {
    await Promise.all(orders.map((o) => api.cancelOrder(o.id).catch(() => {})));
    void refresh();
  }, [orders, refresh]);

  return { orders, loading, submitting, place, cancel, cancelAll, refresh };
}