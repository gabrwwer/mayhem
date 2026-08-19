
export interface MarketSnapshot {
  symbol: string;
  price: number;
  source: string;
  timestamp: string;
}

export interface MarketDataAdapter {
  getSnapshot(symbol: string): Promise<MarketSnapshot>;
}

export class MarketDataClient implements MarketDataAdapter {
  constructor(private readonly source = 'default') {}

  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    return {
      symbol,
      price: 0,
      source: this.source,
      timestamp: new Date().toISOString(),
    };
  }
}