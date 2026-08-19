export type PoolVerificationStatus =
  | 'unverified'
  | 'verified'
  | 'rejected';

export interface TokenDiscoveryEvent {
  tokenMint: string;
  creator: string;

  /**
   * Whether this mint came from pump.fun.
   *
   * Set by whoever knows — normally the discovery wiring, which knows which
   * program it subscribed to. Consumers must prefer this over re-deriving
   * it from the address, because the usual test (`mint.endsWith('pump')`)
   * relies on pump.fun's vanity-address grinding, which is a convention and
   * not a guarantee. Two components deriving it independently is how the
   * launch handler ended up rejecting tokens the bot had already accepted.
   */
  isPumpFun?: boolean;

  /** Unknown unless creator attribution was explicitly verified. */
  creatorSource?: 'not-determined' | 'explicit';

  createdAt: Date;
  poolAddress: string | null;
  quoteToken: string | null;
  initialLiquidity: number | null;
  decimals: number;
  name: string | null;
  symbol: string | null;
  supply: number;

  supplyRaw?: string;

  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataUri: string | null;
  txSignature: string;
  source: string;

  /** Chain data needed for an entry-quality decision. */
  dexProgramId?: string;
  poolType?: 'amm-v4' | 'cpmm';
  poolVerifiedAtMs?: number;  
  
  detectedSlot?: number;
  initializationSlot?: number;
  observedViaWebsocket?: boolean;

  /** No entry may proceed unless this is `verified`. */
  poolVerificationStatus?: PoolVerificationStatus;
  poolVerificationReason?: string;

  /** Verified only after DEX-specific decoding. */
  baseVault?: string | null;
  quoteVault?: string | null;
  quoteReserveSol?: number | null;
  totalLiquiditySol?: number | null;

  /** Optional LP/position information; null means unknown, not safe. */
  lpMint?: string | null;
  lpPositionAddress?: string | null;
  lpLockOrBurnVerified?: boolean | null;
}

export interface LaunchSignal {
  detectedAt: number;
}

export type TokenCallback = (
  event: TokenDiscoveryEvent,
) => void | Promise<void>;

export interface LiquidityChange {
  poolAddress: string;
  tokenMint: string;
  oldLiquidity: number;
  newLiquidity: number;
  changePercent: number;
  timestamp: Date;

  quoteReserveSol?: number;
  totalLiquiditySol?: number;
  slot?: number;
}

export type LiquidityCallback = (
  change: LiquidityChange,
) => void | Promise<void>;

export interface LiquidityAlert {
  poolAddress: string;
  tokenMint: string;
  alertType:
    | 'liquidity_drop'
    | 'price_drop'
    | 'creator_sell'
    | 'large_sell';
  severity: 'warning' | 'critical';
  details: string;
  timestamp: Date;
}