
import { z } from 'zod';

/**
 * Base58 alphabet excludes 0, O, I and l. Solana addresses and signatures are
 * validated by shape here; cryptographic validity is the caller's concern.
 */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const PublicKeySchema = z
  .string()
  .min(32)
  .max(44)
  .regex(BASE58, 'must be a base58-encoded Solana public key')
  .brand<'PublicKey'>();
export type PublicKey = z.infer<typeof PublicKeySchema>;

export const TransactionSignatureSchema = z
  .string()
  .min(86)
  .max(88)
  .regex(BASE58, 'must be a base58-encoded Solana transaction signature')
  .brand<'TransactionSignature'>();
export type TransactionSignature = z.infer<typeof TransactionSignatureSchema>;

export const SlotSchema = z.number().int().nonnegative().brand<'Slot'>();
export type Slot = z.infer<typeof SlotSchema>;

export const BlockhashSchema = z.string().min(32).max(44).regex(BASE58).brand<'Blockhash'>();
export type Blockhash = z.infer<typeof BlockhashSchema>;

/** Milliseconds since the Unix epoch. */
export const TimestampSchema = z.number().int().nonnegative().brand<'Timestamp'>();
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Raw on-chain integer amount, in a mint's smallest unit.
 *
 * Accepts a bigint or a decimal string so the value survives a JSON round trip
 * without silently losing precision through `number`.
 */
export const RawAmountSchema = z
  .union([z.bigint(), z.string().regex(/^\d+$/, 'must be a non-negative integer string')])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)))
  .refine((value) => value >= 0n, 'must be non-negative');

export const TokenAmountSchema = z.object({
  mint: PublicKeySchema,
  /** Amount in the mint's smallest unit. */
  raw: RawAmountSchema,
  /** Mint decimals, needed to render `raw` as a human-readable quantity. */
  decimals: z.number().int().min(0).max(18),
});
export type TokenAmount = z.infer<typeof TokenAmountSchema>;

/** Basis points, where 10_000 bps = 100%. */
export const BasisPointsSchema = z.number().int().min(0).max(10_000).brand<'BasisPoints'>();
export type BasisPoints = z.infer<typeof BasisPointsSchema>;

/** Identifier threading a signal through decision, order, fill and ledger entry. */
export const CorrelationIdSchema = z.string().uuid().brand<'CorrelationId'>();
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case')
  .brand<'AgentId'>();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const StrategyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case')
  .brand<'StrategyId'>();
export type StrategyId = z.infer<typeof StrategyIdSchema>;

/** Confidence in the closed interval [0, 1]. */
export const ConfidenceSchema = z.number().min(0).max(1);

export const EnvironmentSchema = z.enum(['backtest', 'paper', 'devnet', 'mainnet']);
export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Renders a raw amount using its mint decimals. Exact: no float arithmetic.
 */
export function formatTokenAmount(amount: TokenAmount): string {
  const { raw, decimals } = amount;
  if (decimals === 0) return raw.toString();

  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');

  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}