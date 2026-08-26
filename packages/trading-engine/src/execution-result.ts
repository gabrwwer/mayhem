/**
 * The shape this engine requires from any execution venue.
 *
 * Declared structurally here rather than imported from `@mayhem/solana` so
 * the trading engine stays dependency-free and can be exercised against a
 * stub venue in tests. It must stay compatible with
 * `@mayhem/solana`'s `TransactionResult`.
 */
export type ExecutionStatus = 'confirmed' | 'failed' | 'pending' | 'expired';

export interface ExecutionResult {
  signature: string;
  status: ExecutionStatus;
  error?: string | null;
  /** Human-readable SOL fee as an exact decimal string. */
  fees?: string;
  /** Raw fee paid by the transaction, in lamports. */
  feesLamports?: bigint;

  /**
   * Amounts the transaction actually executed, read back from the confirmed
   * transaction. Position quantity and realised P&L must be derived from
   * these rather than from the pre-trade quote.
   */
  /** Human-readable executed input amount as an exact decimal string. */
  filledInputAmount?: string;
  /** Human-readable executed output amount as an exact decimal string. */
  filledOutputAmount?: string;
  /** Raw executed input amount in base units, when available. */
  filledInputRawAmount?: bigint;
  /** Raw executed output amount in base units, when available. */
  filledOutputRawAmount?: bigint;
}

/**
 * True only for a result known to have executed on-chain.
 *
 * The important part is what this rejects: `pending` (may still land),
 * `expired` (will never land, but capital may have been committed), an
 * unrecognised status string, and `null`. Treating "not failed" as "filled"
 * is what let phantom positions into the book.
 */
export function isFilled(
  result: ExecutionResult | null | undefined,
): result is ExecutionResult & { status: 'confirmed' } {
  return result?.status === 'confirmed';
}

/** Statuses where capital may be committed but the outcome is unknown. */
export function isUnresolved(
  result: ExecutionResult | null | undefined,
): boolean {
  return result?.status === 'pending' || result?.status === 'expired';
}
