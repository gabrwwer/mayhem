
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { WsClient } from '../api/ws';
import type { OrderBook, Ticker, Trade, WsMessage } from '../app/type';

const MAX_TRADES = 60;

export interface MarketDataState {
  ticker: Ticker | null;
  book: OrderBook | null;
  trades: Trade[];
  wsStatus: string;
}

/** REST snapshot + live WS stream for one coin. */
export function useMarketData(coin: string): MarketDataState & { refresh: () => void } {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [wsStatus, setWsStatus] = useState('idle');
  const [ws] = useState(() => new WsClient({ onStatusChange: setWsStatus }));

  useEffect(() => {
    ws.connect();
    return () => ws.close();
  }, [ws]);

  // initial REST snapshot
  useEffect(() => {
    let cancelled = false;
    void api
      .getTicker(coin)
      .then((t) => { if (!cancelled) setTicker(t); })
      .catch(() => {});
    void api
      .getOrderBook(coin, 25)
      .then((b) => { if (!cancelled) setBook(b); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [coin]);

  // live WS updates
  useEffect(() => {
    const unsubscribe = ws.subscribe((msg: WsMessage) => {
      if (msg.coin && msg.coin !== coin) return;
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
          setTrades((prev) => [...incoming, ...prev].slice(0, MAX_TRADES));
          break;
        }
      }
    });
    return unsubscribe;
  }, [coin, ws]);

  const refresh = useCallback(() => {
    void api.getTicker(coin).then(setTicker).catch(() => {});
    void api.getOrderBook(coin, 25).then(setBook).catch(() => {});
  }, [coin]);

  return { ticker, book, trades, wsStatus, refresh };
}