
import { TokenCallback, LiquidityCallback } from './types';

export interface TokenDiscoveryProvider {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onToken(callback: TokenCallback): void;
  onLiquidityChange(callback: LiquidityCallback): void;
}