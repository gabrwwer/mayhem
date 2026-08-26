import type { LiquidityAlert } from './types';

export class LiquidityMonitor {
  private readonly watchedPools = new Map<
    string,
    { tokenMint: string; initialLiquidity: number }
  >();

  private readonly alertHandlers: Array<(alert: LiquidityAlert) => void> = [];
  private readonly liquidityDropExitPercent: number;

  constructor(
    _conn: unknown,
    opts: {
      pollIntervalMs?: number;
      liquidityDropExitPercent?: number;
      maxPriceDropPercent?: number;
      creatorSellDetection?: boolean;
    } = {},
  ) {
    this.liquidityDropExitPercent =
      opts.liquidityDropExitPercent ?? 40;
  }

  start(): void {
    // No-op for this lightweight monitor stub.
  }

  stop(): void {
    // No-op for this lightweight monitor stub.
  }

  watchPool(
    poolAddress: string,
    tokenMint: string,
    initialLiquidity: number,
  ): void {
    this.watchedPools.set(poolAddress, {
      tokenMint,
      initialLiquidity,
    });
  }

  unwatchPool(poolAddress: string): void {
    this.watchedPools.delete(poolAddress);
  }

  getWatchedPools(): string[] {
    return Array.from(this.watchedPools.keys());
  }

  onAlert(callback: (alert: LiquidityAlert) => void): void {
    this.alertHandlers.push(callback);
  }

  simulateLiquidityChange(
    poolAddress: string,
    newLiquidity: number,
  ): void {
    const pool = this.watchedPools.get(poolAddress);

    if (!pool) {
      return;
    }

    const { initialLiquidity, tokenMint } = pool;

    if (initialLiquidity <= 0) {
      return;
    }

    const dropPercent = Math.round(
      Math.max(
        0,
        ((initialLiquidity - newLiquidity) / initialLiquidity) * 100,
      ),
    );

    if (dropPercent < this.liquidityDropExitPercent) {
      return;
    }

    const alert: LiquidityAlert = {
      poolAddress,
      tokenMint,
      alertType: 'liquidity_drop',
      severity: 'critical',
      details: `Liquidity dropped by ${dropPercent}% from ${initialLiquidity} to ${newLiquidity}.`,
      timestamp: new Date(),
    };

    for (const handler of this.alertHandlers) {
      try {
        handler(alert);
      } catch {
        // Ignore handler errors so one failing callback
        // does not prevent other callbacks from running.
      }
    }
  }
}
