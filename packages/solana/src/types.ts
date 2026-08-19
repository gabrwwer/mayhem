
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
  fees: number;

  /**
   * Actual executed amounts, as observed from the confirmed transaction.
   *
   * P&L and position quantity MUST be derived from these, not from the
   * pre-trade quote: under volatility the quote-vs-fill gap is largest
   * exactly when accurate accounting matters most. Optional only because
   * some venues cannot report them; a caller that receives `undefined`
   * must log the degradation rather than silently substitute the quote.
   */
  filledInputAmount?: number;
  filledOutputAmount?: number;
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
  inputAmount: number;
  outputAmount: number;
  pricePerToken: number;
  priceImpactPct: number;
  slippageBps: number;
  route: string;
}

export interface WalletInfo {
  publicKey: string;
  solBalance: number;
  tokenBalances: Map<string, number>;
}