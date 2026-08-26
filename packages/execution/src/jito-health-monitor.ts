import { JitoClient } from './jito';

export interface EngineLogger {
  info: (msg: string, data?: any) => void;
  warn: (msg: string, data?: any) => void;
  error: (msg: string, data?: any) => void;
  debug?: (msg: string, data?: any) => void;
}

export class JitoHealthMonitor {
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly jito: JitoClient,
    private readonly logger: EngineLogger,
    private readonly checkIntervalMs = 60_000, // Check every 1 minute
  ) {}

  start(): void {
    this.checkInterval = setInterval(async () => {
      try {
        const accounts = await this.jito.tipAccounts();
        const lastError = this.jito.getTipAccountsLastError();

        if (lastError) {
          this.logger.warn('Jito tip accounts using fallback', {
            accountCount: accounts.length,
            error: lastError.message,
          });
        } else {
          this.logger.debug?.('Jito tip accounts healthy', {
            accountCount: accounts.length,
          });
        }
      } catch (err) {
        this.logger.error('Jito health check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
