import { describe, it, expect } from 'vitest';
import {
  parseAmount,
  formatAmount,
  addAmounts,
  subtractAmounts,
  multiplyAmounts,
  divideAmounts,
  calculatePnL,
  calculateRealizedPnL,
  amountsEqual,
  percentChange,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  decimalStringFromBaseUnits,
} from '../calculations';

describe('Safe Amount Calculations', () => {
  describe('parseAmount', () => {
    it('should parse string amounts', () => {
      const result = parseAmount('0.00000001');
      expect(result.toString()).toBe('0.00000001');
    });

    it('should parse exact decimal strings', () => {
      const result = parseAmount('1000000');
      expect(result.toString()).toBe('1000000');
    });
  });

  describe('formatAmount', () => {
    it('should format to 8 decimals by default', () => {
      const result = formatAmount(parseAmount('0.123456789'), 8);
      expect(result).toBe('0.12345679');
    });

    it('should respect custom decimal places', () => {
      const result = formatAmount(parseAmount('0.123456789'), 2);
      expect(result).toBe('0.12');
    });
  });

  describe('addAmounts', () => {
    it('should add NUMERIC amounts without precision loss', () => {
      const result = addAmounts('0.00000001', '0.00000002');
      expect(result).toBe('0.00000003');
    });

    it('should add multiple amounts', () => {
      const result = addAmounts('1000', '2000', '3000');
      expect(result).toBe('6000');
    });

    it('should handle large amounts', () => {
      const result = addAmounts('1000000000', '1000000000');
      expect(result).toBe('2000000000');
    });
  });

  describe('subtractAmounts', () => {
    it('should subtract amounts precisely', () => {
      const result = subtractAmounts('0.00000005', '0.00000002');
      expect(result).toBe('0.00000003');
    });

    it('should handle negative results', () => {
      const result = subtractAmounts('100', '150');
      expect(result).toBe('-50');
    });
  });

  describe('multiplyAmounts', () => {
    it('should multiply large amounts exactly', () => {
      // 1M tokens at 0.001 SOL each = 1000 SOL
      const result = multiplyAmounts('1000000', '0.001');
      expect(result).toBe('1000');
    });

    it('should multiply small amounts precisely', () => {
      const result = multiplyAmounts('0.5', '0.2');
      expect(result).toBe('0.1');
    });
  });

  describe('divideAmounts', () => {
    it('should divide amounts with precision', () => {
      const result = divideAmounts('1000', '2');
      expect(result).toBe('500');
    });

    it('should handle fractional results', () => {
      const result = divideAmounts('1', '3');
      // Decimal.js divides precisely
      expect(parseAmount(result).times('3').toNumber()).toBeCloseTo(1);
    });
  });

  describe('calculatePnL', () => {
    it('should calculate profit correctly', () => {
      // Buy 1000 tokens at 0.01 SOL, sell at 0.02 SOL
      // PnL = (0.02 - 0.01) * 1000 = 10 SOL
      const pnl = calculatePnL('0.01', '0.02', '1000');
      expect(pnl).toBe('10');
    });

    it('should calculate loss correctly', () => {
      // Buy 1000 tokens at 0.02 SOL, sell at 0.01 SOL
      // PnL = (0.01 - 0.02) * 1000 = -10 SOL
      const pnl = calculatePnL('0.02', '0.01', '1000');
      expect(pnl).toBe('-10');
    });

    it('should handle small price changes', () => {
      // Buy at 1 lamport, sell at 2 lamports, 1M tokens
      const pnl = calculatePnL('0.000000001', '0.000000002', '1000000');
      expect(pnl).toBe('0.001');
    });
  });

  describe('calculateRealizedPnL', () => {
    it('should sum PnL across multiple positions', () => {
      const positions = [
        {
          mint: 'token1',
          entryPrice: '0.01',
          exitPrice: '0.02',
          quantity: '1000',
        },
        {
          mint: 'token2',
          entryPrice: '0.10',
          exitPrice: '0.05',
          quantity: '100',
        },
      ];

      const result = calculateRealizedPnL(positions);
      
      // Token1: (0.02 - 0.01) * 1000 = 10 SOL
      // Token2: (0.05 - 0.10) * 100 = -5 SOL
      // Total: 10 - 5 = 5 SOL
      expect(result.totalPnL).toBe('5');
      expect(result.byMint['token1']).toBe('10');
      expect(result.byMint['token2']).toBe('-5');
    });

    it('should skip positions without exit price', () => {
      const positions = [
        {
          mint: 'token1',
          entryPrice: '0.01',
          exitPrice: '0.02',
          quantity: '1000',
        },
        {
          mint: 'token2',
          entryPrice: '0.10',
          quantity: '100',
        },
      ];

      const result = calculateRealizedPnL(positions);
      expect(result.totalPnL).toBe('10');
      expect(result.byMint['token1']).toBe('10');
      expect(result.byMint['token2']).toBeUndefined();
    });
  });

  describe('amountsEqual', () => {
    it('should consider identical amounts equal', () => {
      expect(amountsEqual('100', '100')).toBe(true);
    });

    it('should use default tolerance for floating point comparison', () => {
      expect(amountsEqual('0.00000001', '0.00000001')).toBe(true);
    });

    it('should respect custom tolerance', () => {
      expect(amountsEqual('100', '100.5', '1')).toBe(true);
      expect(amountsEqual('100', '100.5', '0.1')).toBe(false);
    });
  });

  describe('percentChange', () => {
    it('should calculate positive percentage change', () => {
      // Change from 100 to 150 = 50%
      const result = percentChange('100', '150');
      expect(result).toBe('50');
    });

    it('should calculate negative percentage change', () => {
      // Change from 100 to 50 = -50%
      const result = percentChange('100', '50');
      expect(result).toBe('-50');
    });

    it('should handle zero old value', () => {
      const result = percentChange('0', '100');
      expect(result).toBe('0');
    });
  });
});

describe('base-unit conversion boundaries', () => {
  it('preserves a raw amount above Number.MAX_SAFE_INTEGER exactly', () => {
    const raw = 9_007_199_254_740_993n;
    expect(decimalStringFromBaseUnits(raw, 9)).toBe('9007199.254740993');
    expect(decimalToBaseUnits('9007199.254740993', 9)).toBe(raw);
  });

  it('preserves very small token prices and rounds order raw units down explicitly', () => {
    expect(baseUnitsToDecimal(1n, 12).toFixed()).toBe('0.000000000001');
    expect(decimalToBaseUnits('1.9999999', 6).toString()).toBe('1999999');
  });
});
