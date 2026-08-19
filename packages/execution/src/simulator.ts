
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { QuoteResult, TransactionResult } from '@mayhem/solana';
import { readBondingCurve } from './pumpfun';

export interface SimulatorConfig {
  slippageBps: number;
  failureRate: number;
  initialSolBalance: number;

  // Simulated price movement per monitoring tick.
  // 0.05 = approximately +/-5% random movement per tick.
  volatility?: number;

  // When set, getPrice() fetches real quotes from Jupiter/PumpFun
  // instead of using the random walk simulator.
  rpcUrl?: string;
}

export class SimulatedExecutionEngine {
  private config: SimulatorConfig;
  private solBalance: number;
  private tokenBalances: Map<string, number> = new Map();
  private prices: Map<string, number> = new Map();
  private tradeLog: TransactionResult[] = [];

  constructor(config: SimulatorConfig) {
    this.config = config;
    this.solBalance = config.initialSolBalance;
  }

  getBalance(): number {
    return this.solBalance;
  }

  /**
   * Return the simulator's current marked portfolio equity in lamports.
   * This is only used for paper-trading safety accounting; it never represents
   * a live wallet balance.
   */
  getPortfolioEquityLamports(): bigint {
    let equitySol = this.solBalance;

    for (const [mint, amount] of this.tokenBalances.entries()) {
      const price = this.prices.get(mint);
      if (
        price !== undefined &&
        Number.isFinite(price) &&
        price >= 0 &&
        Number.isFinite(amount) &&
        amount >= 0
      ) {
        equitySol += amount * price;
      }
    }

    if (!Number.isFinite(equitySol) || equitySol < 0) {
      throw new Error('Simulator portfolio equity became invalid');
    }

    return BigInt(Math.round(equitySol * 1e9));
  }

  getTokenBalance(mint: string): number {
    return this.tokenBalances.get(mint) ?? 0;
  }

  getTradeLog(): TransactionResult[] {
    return [...this.tradeLog];
  }

  /**
   * Return the current market price.
   * When rpcUrl is configured, fetches real prices from Jupiter/PumpFun.
   * Otherwise falls back to the simulated random walk.
   */
  /** Counts price-source failures so a broken feed is visible, not silent. */
  private priceFailures = 0;

  async getPrice(tokenMint: string): Promise<number> {
    if (this.config.rpcUrl) {
      try {
        return await this.fetchRealPrice(tokenMint);
      } catch (error) {
        /*
         * A silent catch here cost hours of debugging.
         *
         * When the price source failed, this returned the hardcoded 0.001
         * default — identical for every token and constant over time. That
         * is indistinguishable, downstream, from a real market that is not
         * moving: momentum confirmation measured 0.00% change and rejected
         * every candidate, with nothing in any log to say why.
         *
         * A price feed that cannot price is an error, not a zero.
         */
        this.priceFailures += 1;
        if (this.priceFailures <= 3 || this.priceFailures % 50 === 0) {
          console.warn(
            JSON.stringify({
              level: 'error',
              msg: 'PRICE_SOURCE_FAILED',
              mint: tokenMint,
              failures: this.priceFailures,
              error: error instanceof Error ? error.message : String(error),
              note: 'falling back to a constant price; momentum and P&L are meaningless until fixed',
            }),
          );
        }
      }
    }
    return this.prices.get(tokenMint) ?? 0.001;
  }

  getPriceFailureCount(): number {
    return this.priceFailures;
  }

  /**
   * Sellable SOL depth backing a token, in SOL.
   *
   * For a pre-graduation pump.fun token there is no liquidity pool — supply
   * sits in the bonding curve — so pool-based liquidity figures are
   * structurally 0 and cannot be used to bound position size. The curve's
   * real SOL reserves are the quantity that actually constrains an exit:
   * they are what a sell draws down.
   *
   * `virtualSolReserves` is deliberately NOT used here. It includes the
   * curve's virtual offset, which exists to shape the price function and is
   * not withdrawable — sizing against it would overstate exit capacity by
   * roughly the offset, which is largest exactly when the token is newest
   * and thinnest.
   *
   * Returns null when depth cannot be determined, so callers can distinguish
   * "no depth" from "unknown depth" and fail closed on the latter.
   */
  async getDepthSol(tokenMint: string): Promise<number | null> {
    if (!this.config.rpcUrl) return null;

    try {
      const curve = await readBondingCurve(
        this.getConnection(),
        new PublicKey(tokenMint),
      );

      if (!curve) return null;

      const depthSol = Number(curve.realSolReserves) / 1e9;
      return Number.isFinite(depthSol) && depthSol >= 0 ? depthSol : null;
    } catch {
      // An unreadable curve is unknown depth, not zero depth.
      return null;
    }
  }

  /** Lazily created; only needed when a real price source is configured. */
  private connection: Connection | null = null;

  private getConnection(): Connection {
    if (!this.connection) {
      this.connection = new Connection(this.config.rpcUrl!, 'confirmed');
    }
    return this.connection;
  }

  private async fetchRealPrice(tokenMint: string): Promise<number> {
    /*
     * Always attempt the bonding curve, regardless of address suffix.
     *
     * This used to be gated on `isPumpFunToken()`, which tests whether the
     * mint address ends in "pump" — a vanity-grinding convention, not a
     * guarantee. Tokens discovered from the pump.fun program whose address
     * lacks the suffix skipped the curve read entirely, fell through to a
     * Jupiter route that does not exist for a new mint, and ended up on the
     * constant 0.001 fallback — reporting 0.00% movement forever.
     *
     * Reading the curve is self-validating: the PDA simply will not exist
     * for a non-pump.fun mint, so `readBondingCurve` returns null and the
     * Jupiter path still runs. Trying costs one lookup and removes a whole
     * class of silently-mispriced tokens.
     */
    {
      /*
       * Price from the BONDING CURVE, not the pump.fun HTTP API.
       *
       * The API route was wrong twice over:
       *   - it 404s for a token minted seconds ago, because it has not been
       *     indexed yet — which is exactly when this bot looks. Every such
       *     failure fell through to the cached value, and the dry-run loop
       *     then random-walked it, so the "live" P&L was synthetic;
       *   - `market_cap / total_supply` mixes units: market cap in USD,
       *     supply in raw base units. That is where the 1e-14 prices came
       *     from.
       *
       * The curve gives the true instantaneous price in SOL per token:
       * virtualSolReserves / virtualTokenReserves, both raw integers, and
       * it exists from the moment the mint does.
       */
      try {
        // Wrap RPC call in a timeout to prevent indefinite hangs
        const curve = await Promise.race([
          readBondingCurve(
            this.getConnection(),
            new PublicKey(tokenMint),
          ),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('RPC timeout')), 5000)
          ),
        ]);

        if (curve && curve.virtualTokenReserves > 0n) {
          // lamports/raw-token -> SOL per whole token.
          // SOL has 9 decimals, pump.fun mints have 6.
          const solPerRawToken =
            Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
          const price = (solPerRawToken / 1e9) * 1e6;

          if (Number.isFinite(price) && price > 0) {
            this.prices.set(tokenMint, price);
            return price;
          }
        }
      } catch (err) {
        // RPC timeout or error; fall through to Jupiter API
      }
    }

    const params = new URLSearchParams({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: tokenMint,
      amount: '1000000',
      slippageBps: '100',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`, {
        signal: controller.signal,
      });
      if (resp.ok) {
        const data = await resp.json() as { outAmount?: string };
        if (data.outAmount) {
          const outTokens = Number(data.outAmount) / 1e6;
          const price = 0.001 / outTokens;
          this.prices.set(tokenMint, price);
          return price;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    throw new Error('Real price fetch failed');
  }

  /**
   * Advance the simulated market price by one monitoring tick.
   */
  simulatePrice(
    tokenMint: string,
    currentPrice: number,
    volatility = this.config.volatility ?? 0.05,
  ): number {
    const cached = this.prices.get(tokenMint);
    const base = cached ?? currentPrice;

    const dt = 1;
    const drift = 0;
    const randomShock = (Math.random() - 0.5) * 2;

    const priceChange =
      base *
      (drift * dt + volatility * Math.sqrt(dt) * randomShock);

    const newPrice = Math.max(
      base + priceChange,
      0.000001,
    );

    this.prices.set(tokenMint, newPrice);
    return newPrice;
  }

  /**
   * Initialize a simulated market price when a token first enters
   * the trading engine.
   */
  setPrice(tokenMint: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid simulated price: ${price}`);
    }

    this.prices.set(tokenMint, price);
  }

  async quoteBuy(
    tokenMint: string,
    amountSol: number,
  ): Promise<QuoteResult> {
    const price = this.prices.get(tokenMint) ?? 0.001;

    const slippageMultiplier =
      1 + this.config.slippageBps / 10_000;

    const effectivePrice = price * slippageMultiplier;
    const outputAmount = amountSol / effectivePrice;
    const priceImpact = (amountSol / 100) * 0.5;

    return {
      inputMint:
        'So11111111111111111111111111111111111111112',
      outputMint: tokenMint,
      inputAmount: amountSol,
      outputAmount,
      pricePerToken: effectivePrice,
      priceImpactPct: Math.min(priceImpact, 50),
      slippageBps: this.config.slippageBps,
      route: 'simulated-paper',
    };
  }

  async quoteSell(
    tokenMint: string,
    amountToken: number,
  ): Promise<QuoteResult> {
    const price = this.prices.get(tokenMint) ?? 0.001;

    const slippageMultiplier =
      1 - this.config.slippageBps / 10_000;

    const effectivePrice = price * slippageMultiplier;
    const outputAmount = amountToken * effectivePrice;
    const priceImpact = (outputAmount / 100) * 0.5;

    return {
      inputMint: tokenMint,
      outputMint:
        'So11111111111111111111111111111111111111112',
      inputAmount: amountToken,
      outputAmount,
      pricePerToken: effectivePrice,
      priceImpactPct: Math.min(priceImpact, 50),
      slippageBps: this.config.slippageBps,
      route: 'simulated-paper',
    };
  }

  /**
   * Compatibility methods used by MayhemEngine.
   * In paper trading these simply return the quote because there
   * is no real Solana transaction to construct.
   */
  async buildBuyTransaction(
    quote: QuoteResult,
  ): Promise<QuoteResult> {
    return quote;
  }

  async buildSellTransaction(
    quote: QuoteResult,
  ): Promise<QuoteResult> {
    return quote;
  }

  async simulateTransaction(
    _tx: Transaction,
  ): Promise<{
    success: boolean;
    error?: string;
    unitsConsumed?: number;
  }> {
    const fails = Math.random() < this.config.failureRate;

    if (fails) {
      return {
        success: false,
        error: 'Simulated random failure',
        unitsConsumed: 0,
      };
    }

    return {
      success: true,
      unitsConsumed: 200_000,
    };
  }

  async signAndSendTransaction(
    quote: QuoteResult,
  ): Promise<TransactionResult> {
    const isBuy =
      quote.inputMint ===
      'So11111111111111111111111111111111111111112';

    const fails =
      Math.random() < this.config.failureRate;

    if (fails) {
      const result: TransactionResult = {
        signature:
          'sim-fail-' + Date.now().toString(36),
        status: 'failed',
        slot: Math.floor(Math.random() * 1_000_000),
        error: 'Simulated transaction failure',
        fees: 0,
      };

      this.tradeLog.push(result);
      return result;
    }

    if (isBuy) {
      if (this.solBalance < quote.inputAmount) {
        const result: TransactionResult = {
          signature:
            'sim-nsf-' + Date.now().toString(36),
          status: 'failed',
          slot: 0,
          error: 'Insufficient SOL balance',
          fees: 0,
        };

        this.tradeLog.push(result);
        return result;
      }

      this.solBalance -= quote.inputAmount;

      const current =
        this.tokenBalances.get(quote.outputMint) ?? 0;

      this.tokenBalances.set(
        quote.outputMint,
        current + quote.outputAmount,
      );

      // Establish the market price used by getPrice().
      this.setPrice(
        quote.outputMint,
        quote.pricePerToken,
      );
    } else {
      const currentTokens =
        this.tokenBalances.get(quote.inputMint) ?? 0;

      if (currentTokens < quote.inputAmount) {
        const result: TransactionResult = {
          signature:
            'sim-nsf-' + Date.now().toString(36),
          status: 'failed',
          slot: 0,
          error: 'Insufficient token balance',
          fees: 0,
        };

        this.tradeLog.push(result);
        return result;
      }

      this.tokenBalances.set(
        quote.inputMint,
        currentTokens - quote.inputAmount,
      );

      this.solBalance += quote.outputAmount;
    }

    const simulatedFees = 0.000005;

    this.solBalance -= simulatedFees;

    const result: TransactionResult = {
      signature:
        'sim-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2, 8),
      status: 'confirmed',
      slot: Math.floor(Math.random() * 1_000_000),
      error: null,
      fees: simulatedFees,
      // Report executed amounts so the trading engine books P&L from the
      // fill rather than falling back to quote-based estimation. In paper
      // trading the fill equals the quote; the point is that the *contract*
      // matches a live venue, so the fill-vs-quote code path is exercised
      // in dry run instead of being first tested with real money.
      filledInputAmount: quote.inputAmount,
      filledOutputAmount: quote.outputAmount,
    };

    console.log(
      `[PaperTrade] ${
        isBuy ? 'BUY' : 'SELL'
      } ${
        isBuy
          ? quote.outputAmount.toFixed(4)
          : quote.inputAmount.toFixed(4)
      } tokens @ ${quote.pricePerToken.toFixed(8)} | SOL balance: ${this.solBalance.toFixed(4)}`,
    );

    this.tradeLog.push(result);

    return result;
  }

  /**
   * Advance every active simulated market.
   */
  simulateAllPrices(): void {
    for (const [mint, price] of this.prices.entries()) {
      this.simulatePrice(
        mint,
        price,
        this.config.volatility ?? 0.05,
      );
    }
  }
}