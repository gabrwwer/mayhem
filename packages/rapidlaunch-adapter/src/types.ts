
export interface RapidLaunchConfig {
  apiUrl: string | undefined;
  apiKey: string | undefined;
}

export interface RapidLaunchToken {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  launchTime: Date;
  poolAddress: string;
  liquidity: number;
  status: string;
}

export interface RapidLaunchStatus {
  connected: boolean;
  lastSync: Date | null;
  error: string | null;
}