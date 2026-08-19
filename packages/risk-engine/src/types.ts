
export type RiskLevel = 'SAFE' | 'CAUTION' | 'HIGH_RISK' | 'BLOCKED';

export interface RiskConfig {
  minLiquiditySol: number;
  maxTopHolderPercent: number;
  minHolders: number;
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
  maxDailyLossSol: number;
  maxExposureSol: number;
  cooldownMs: number;
  emergencyStop: boolean;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  minLiquiditySol: 5,
  maxTopHolderPercent: 30,
  minHolders: 10,
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  maxDailyLossSol: 1,
  maxExposureSol: 0.5,
  cooldownMs: 5000,
  emergencyStop: false,
};

export interface RiskAssessment {
  tokenMint: string;
  level: RiskLevel;
  score: number;
  checks: RiskCheck[];
  timestamp: Date;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  value: any;
  threshold: any;
  message: string;
}

export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadata: Record<string, any> | null;
}

export interface PoolInfo {
  address: string;
  tokenMint: string;
  liquiditySol: number;
  liquidityToken: number;
  price: number;
  volume24h: number;
  active: boolean;
}

export interface HolderInfo {
  address: string;
  percentage: number;
}