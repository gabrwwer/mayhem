/**
 * Safe arithmetic on NUMERIC strings (from database)
 * NUMERIC(20,8) strings can have up to 12 integer digits and 8 decimal places
 */

import Decimal from 'decimal.js';

Decimal.set({ toExpNeg: -100, toExpPos: 1_000_000 });

/**
 * A human-unit financial value at a process/API/persistence boundary.
 *
 * Financial values intentionally enter the live engine as strings. Accepting
 * a JavaScript number here would only preserve the approximation that was
 * already made before Decimal.js could protect it.
 */
export type DecimalValue = string;

function decimalString(decimal: Decimal): string {
  return decimal.toFixed();
}

export function parseAmount(amount: DecimalValue | Decimal): Decimal {
  return amount instanceof Decimal ? amount : new Decimal(amount);
}

/** Convert an exact base-unit integer to a human-unit Decimal. */
export function baseUnitsToDecimal(amount: bigint, decimals: number): Decimal {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  return new Decimal(amount.toString()).div(new Decimal(10).pow(decimals));
}

/**
 * Convert a human-unit Decimal to raw units with an explicit rounding rule.
 * Trading amounts are rounded down so a requested order can never spend or
 * transfer more than the exact value supplied by the caller.
 */
export function decimalToBaseUnits(
  amount: DecimalValue | Decimal,
  decimals: number,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const raw = parseAmount(amount)
    .times(new Decimal(10).pow(decimals))
    .toDecimalPlaces(0, Decimal.ROUND_DOWN);
  if (raw.isNegative()) throw new Error('Base-unit amount cannot be negative');
  return BigInt(raw.toFixed(0));
}

export function decimalStringFromBaseUnits(amount: bigint, decimals: number): DecimalValue {
  return decimalString(baseUnitsToDecimal(amount, decimals));
}

export function formatAmount(decimal: Decimal, decimals = 8): string {
  return decimal.toFixed(decimals);
}

export function addAmounts(...amounts: DecimalValue[]): string {
  return amounts.reduce<string>((sum, amt) =>
    decimalString(parseAmount(sum).plus(parseAmount(amt))),
    '0'
  );
}

export function subtractAmounts(a: DecimalValue, b: DecimalValue): string {
  return decimalString(parseAmount(a).minus(parseAmount(b)));
}

export function multiplyAmounts(a: DecimalValue, b: DecimalValue): string {
  return decimalString(parseAmount(a).times(parseAmount(b)));
}

export function divideAmounts(a: DecimalValue, b: DecimalValue): string {
  return decimalString(parseAmount(a).dividedBy(parseAmount(b)));
}

export function calculatePnL(
  entryPrice: string,
  exitPrice: string,
  size: string,
): string {
  // PnL = (exitPrice - entryPrice) * size
  return multiplyAmounts(
    subtractAmounts(exitPrice, entryPrice),
    size,
  );
}

export function calculateRealizedPnL(positions: Array<{
  mint: string;
  entryPrice: string;
  exitPrice?: string;
  quantity: string;
}>): {
  totalPnL: string;
  byMint: Record<string, string>;
} {
  const byMint: Record<string, string> = {};
  
  for (const pos of positions) {
    if (!pos.exitPrice) continue;
    
    const pnl = calculatePnL(pos.entryPrice, pos.exitPrice, pos.quantity);
    byMint[pos.mint] = addAmounts(byMint[pos.mint] ?? '0', pnl);
  }
  
  const totalPnL = Object.values(byMint).reduce(
    (sum, pnl) => addAmounts(sum, pnl),
    '0'
  );
  
  return { totalPnL, byMint };
}

/**
 * Compare two amounts with numeric tolerance for floating point results
 */
export function amountsEqual(
  a: DecimalValue,
  b: DecimalValue,
  tolerance = '0.00000001',
): boolean {
  const diff = parseAmount(a).minus(parseAmount(b)).abs();
  return diff.lessThanOrEqualTo(parseAmount(tolerance));
}

/**
 * Get percentage change from old value to new value
 */
export function percentChange(
  oldValue: string | number,
  newValue: string | number,
): string {
  const old = parseAmount(String(oldValue));
  if (old.isZero()) {
    return '0';
  }
  return decimalString(parseAmount(String(newValue))
    .minus(old)
    .dividedBy(old)
    .times('100')
  );
}
