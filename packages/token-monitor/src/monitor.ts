import { TokenDiscoveryProvider } from './provider';
import {
  TokenCallback,
  TokenDiscoveryEvent,
  LiquidityCallback,
} from './types';

const MAX_DISCOVERED_TOKENS = 10_000;

export class TokenMonitor {
  private readonly providers: TokenDiscoveryProvider[] = [];
  private readonly tokenCallbacks: TokenCallback[] = [];
  private readonly liquidityCallbacks: LiquidityCallback[] = [];
  private readonly discoveredTokens = new Map<string, TokenDiscoveryEvent>();
  private started = false;

  addProvider(provider: TokenDiscoveryProvider): void {
    if (this.started) {
      throw new Error('Cannot add a provider after TokenMonitor has started');
    }

    provider.onToken((event) => {
      void this.handleToken(event);
    });

    provider.onLiquidityChange((change) => {
      for (const callback of this.liquidityCallbacks) {
        try {
          void Promise.resolve(callback(change)).catch((error: unknown) => {
            console.warn(
              '[TokenMonitor] liquidity callback failed:',
              error instanceof Error ? error.message : String(error),
            );
          });
        } catch (error) {
          console.warn(
            '[TokenMonitor] liquidity callback failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    });

    this.providers.push(provider);
  }

  onToken(callback: TokenCallback): void {
    this.tokenCallbacks.push(callback);
  }

  onLiquidityChange(callback: LiquidityCallback): void {
    this.liquidityCallbacks.push(callback);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      await Promise.all(this.providers.map((provider) => provider.start()));
    } catch (error) {
      await Promise.allSettled(
        this.providers.map(async (provider) => {
          try {
            await provider.stop();
          } catch {
            // Preserve the original startup error.
          }
        }),
      );
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    const results = await Promise.allSettled(
      this.providers.map((provider) => provider.stop()),
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    if (failures.length > 0) {
      const message = failures
        .map((failure) =>
          failure.reason instanceof Error
            ? failure.reason.message
            : String(failure.reason),
        )
        .join('; ');
      throw new Error(`TokenMonitor provider shutdown failed: ${message}`);
    }
  }

  getDiscoveredTokens(): TokenDiscoveryEvent[] {
    return [...this.discoveredTokens.values()];
  }

  private async handleToken(event: TokenDiscoveryEvent): Promise<void> {
    if (this.discoveredTokens.has(event.tokenMint)) {
      return;
    }

    if (this.discoveredTokens.size >= MAX_DISCOVERED_TOKENS) {
      const oldest = this.discoveredTokens.keys().next().value;
      if (typeof oldest === 'string') {
        this.discoveredTokens.delete(oldest);
      }
    }

    this.discoveredTokens.set(event.tokenMint, event);

    for (const callback of this.tokenCallbacks) {
      try {
        await callback(event);
      } catch (error) {
        console.warn(
          `[TokenMonitor] token callback failed mint=${event.tokenMint}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}