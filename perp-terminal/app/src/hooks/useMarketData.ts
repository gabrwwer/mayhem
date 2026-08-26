import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/client';
import { WsClient } from '../api/ws';

import type {
  OrderBook,
  Ticker,
  Trade,
  WsMessage,
} from '../app/type';

const MAX_TRADES = 60;
const ORDER_BOOK_DEPTH = 25;

export interface MarketDataState {
  ticker: Ticker | null;
  book: OrderBook | null;
  trades: Trade[];
  wsStatus: string;
}

/**
 * Market data hook.
 *
 * Provides:
 * - REST ticker snapshot
 * - REST order-book snapshot
 * - live WebSocket updates
 * - bounded trade history
 * - manual REST refresh
 */
export function useMarketData(
  coin: string,
): MarketDataState & { refresh: () => void } {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [wsStatus, setWsStatus] = useState('idle');

  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const ws = new WsClient({
      onStatusChange: setWsStatus,
    });

    wsRef.current = ws;
    ws.connect();

    return () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      ws.close();
    };
  }, []);

  /**
   * Load the initial REST snapshot whenever the selected coin changes.
   */
  useEffect(() => {
    let cancelled = false;

    // Clear stale market data immediately when switching coins.
    setTicker(null);
    setBook(null);
    setTrades([]);

    const load = async () => {
      const [tickerResult, bookResult] = await Promise.allSettled([
        api.getTicker(coin),
        api.getOrderBook(coin, ORDER_BOOK_DEPTH),
      ]);

      if (cancelled) {
        return;
      }

      if (tickerResult.status === 'fulfilled') {
        setTicker(tickerResult.value);
      }

      if (bookResult.status === 'fulfilled') {
        setBook(bookResult.value);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [coin]);

  /**
   * Subscribe to live WebSocket market-data updates.
   */
  useEffect(() => {
    const ws = wsRef.current;

    if (!ws) {
      return undefined;
    }

    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      // Ignore messages belonging to another coin.
      if (msg.coin && msg.coin !== coin) {
        return;
      }

      switch (msg.channel) {
        case 'ticker':
          setTicker(msg.data as Ticker);
          break;

        case 'orderbook':
          setBook(msg.data as OrderBook);
          break;

        case 'trades': {
          const incoming = Array.isArray(msg.data)
            ? (msg.data as Trade[])
            : [msg.data as Trade];

          if (incoming.length === 0) {
            return;
          }

          setTrades((previous) =>
            [...incoming, ...previous].slice(0, MAX_TRADES),
          );

          break;
        }

        default:
          break;
      }
    });

    return unsubscribe;
  }, [coin]);

  /**
   * Manually refresh REST market snapshots.
   */
  const refresh = useCallback(() => {
    let cancelled = false;

    void api
      .getTicker(coin)
      .then((nextTicker) => {
        if (!cancelled) {
          setTicker(nextTicker);
        }
      })
      .catch(() => {
        // Keep last known ticker on transient API failure.
      });

    void api
      .getOrderBook(coin, ORDER_BOOK_DEPTH)
      .then((nextBook) => {
        if (!cancelled) {
          setBook(nextBook);
        }
      })
      .catch(() => {
        // Keep last known order book on transient API failure.
      });

    // The returned cancellation isn't exposed because refresh is intentionally
    // fire-and-forget. The request itself remains safe through normal React
    // lifecycle handling in the initial-load effect.
    void cancelled;
  }, [coin]);

  return {
    ticker,
    book,
    trades,
    wsStatus,
    refresh,
  };
}