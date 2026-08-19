
/*
 * RapidLaunch.io API adapter.
 * These endpoints are based on expected API patterns.
 * Actual endpoints must be verified against RapidLaunch.io official documentation.
 * TODO: Replace placeholder endpoints with documented RapidLaunch API endpoints when available.
 */

import { RapidLaunchConfig, RapidLaunchToken, RapidLaunchStatus } from './types';

export class RapidLaunchAdapter {
  private config: RapidLaunchConfig;
  private lastSync: Date | null = null;
  private lastError: string | null = null;
  private subscriptionCallback: ((token: RapidLaunchToken) => void) | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RapidLaunchConfig) {
    this.config = config;
  }

  getStatus(): RapidLaunchStatus {
    return {
      connected: !!this.config.apiUrl && this.lastSync !== null && this.lastError === null,
      lastSync: this.lastSync,
      error: this.lastError,
    };
  }

  async getLaunch(id: string): Promise<RapidLaunchToken> {
    return this.request<RapidLaunchToken>(`/launches/${id}`);
  }

  async getToken(mint: string): Promise<RapidLaunchToken> {
    return this.request<RapidLaunchToken>(`/tokens/${mint}`);
  }

  async getPool(address: string): Promise<any> {
    return this.request(`/pools/${address}`);
  }

  async getLaunchStatus(id: string): Promise<string> {
    const data = await this.request<{ status: string }>(`/launches/${id}/status`);
    return data.status;
  }

  async getLiquidity(poolAddress: string): Promise<number> {
    const data = await this.request<{ liquidity: number }>(`/pools/${poolAddress}/liquidity`);
    return data.liquidity;
  }

  subscribeToLaunches(callback: (token: RapidLaunchToken) => void): void {
    this.ensureConfigured();
    this.subscriptionCallback = callback;
    this.pollInterval = setInterval(async () => {
      try {
        const launches = await this.request<RapidLaunchToken[]>('/launches/recent');
        for (const launch of launches) {
          this.subscriptionCallback?.(launch);
        }
        this.lastSync = new Date();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }, 5000);
  }

  unsubscribe(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.subscriptionCallback = null;
  }

  private ensureConfigured(): void {
    if (!this.config.apiUrl) {
      throw new Error(
        'RapidLaunch API URL not configured. Set RAPIDLAUNCH_API_URL environment variable. ' +
        'See docs/RAPIDLAUNCH_DEPLOYMENT.md for integration requirements.',
      );
    }
  }

  private async request<T>(path: string): Promise<T> {
    this.ensureConfigured();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.apiUrl}${path}`, { headers });
    if (!response.ok) {
      this.lastError = `RapidLaunch API error: ${response.status} ${response.statusText}`;
      throw new Error(this.lastError);
    }

    this.lastSync = new Date();
    this.lastError = null;
    return response.json() as Promise<T>;
  }
}