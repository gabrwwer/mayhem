
export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataUri: string;
  creator: string;
  createdAt: Date;
}

export interface PoolInfo {
  address: string;
  tokenMint: string;
  quoteMint: string;
  liquidity: number;
  reserveToken: number;
  reserveQuote: number;
  status: 'active' | 'inactive' | 'unknown';
}

/**
 * `pending` and `expired` are explicit states so callers cannot fall into
 * the "anything that isn't 'failed' must be a fill" trap. Only `confirmed`
 * may be treated as a fill.
 */
export type TransactionStatus = 'confirmed' | 'failed' | 'pending' | 'expired';

export interface TransactionResult {
  signature: string;
  status: TransactionStatus;
  slot: number;
  error: string | null;
  /** Human-readable SOL fee as an exact decimal string. */
  fees: string;
  /** Raw fee paid by the transaction, in lamports. */
  feesLamports?: bigint;

  /**
   * Actual executed amounts, as observed from the confirmed transaction.
   *
   * P&L and position quantity MUST be derived from these, not from the
   * pre-trade quote: under volatility the quote-vs-fill gap is largest
   * exactly when accurate accounting matters most. Optional only because
   * some venues cannot report them; a caller that receives `undefined`
   * must log the degradation rather than silently substitute the quote.
   */
  /** Human-readable executed input amount as an exact decimal string. */
  filledInputAmount?: string;
  /** Human-readable executed output amount as an exact decimal string. */
  filledOutputAmount?: string;
  /** Raw executed input amount in base units, when the venue can report it. */
  filledInputRawAmount?: bigint;
  /** Raw executed output amount in base units, when the venue can report it. */
  filledOutputRawAmount?: bigint;
}

/** True only for a transaction that is known to have executed on-chain. */
export function isFilled(
  result: TransactionResult | null | undefined,
): result is TransactionResult & { status: 'confirmed' } {
  return result?.status === 'confirmed';
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  /** Human-readable input amount as an exact decimal string. */
  inputAmount: string;
  /** Human-readable output amount as an exact decimal string. */
  outputAmount: string;
  /** Raw input amount in base units. */
  inputRawAmount?: bigint;
  /** Raw output amount in base units. */
  outputRawAmount?: bigint;
  /** Human-readable price as an exact decimal string. */
  pricePerToken: string;
  /** Human-readable percentage as an exact decimal string. */
  priceImpactPct: string;
  slippageBps: number;
  route: string;
}

export interface WalletInfo {
  publicKey: string;
  solBalance: number;
  tokenBalances: Map<string, number>;
}
