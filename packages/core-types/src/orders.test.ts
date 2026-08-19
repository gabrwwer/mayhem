
import { describe, expect, it } from 'vitest';
import {
  OrderIntentSchema,
  OrderStateSchema,
  canTransition,
  isTerminalOrderState,
  requiresReconciliation,
} from './orders.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const baseIntent = {
  intentId: '11111111-1111-4111-8111-111111111111',
  correlationId: '22222222-2222-4222-8222-222222222222',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_005_000,
  proposedBy: 'agent-sniper',
  strategyId: 'launch-snipe',
  environment: 'paper',
  side: 'buy',
  inputMint: WSOL,
  outputMint: USDC,
  amountIn: '1000000000',
  maxSlippageBps: 100,
  priorityFeeMicroLamports: 50_000,
  confidence: 0.8,
  rationale: 'liquidity added and sellability simulated',
};

describe('OrderIntentSchema', () => {
  it('parses a well-formed intent', () => {
    const intent = OrderIntentSchema.parse(baseIntent);
    expect(intent.amountIn).toBe(1_000_000_000n);
  });

  it('rejects an intent that expires before it was created', () => {
    const result = OrderIntentSchema.safeParse({ ...baseIntent, expiresAt: baseIntent.createdAt });
    expect(result.success).toBe(false);
  });

  it('rejects a swap between identical mints', () => {
    const result = OrderIntentSchema.safeParse({ ...baseIntent, outputMint: WSOL });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    const result = OrderIntentSchema.safeParse({ ...baseIntent, bypassRisk: true });
    expect(result.success).toBe(false);
  });

  it('rejects slippage above 100 percent', () => {
    expect(OrderIntentSchema.safeParse({ ...baseIntent, maxSlippageBps: 10_001 }).success).toBe(
      false,
    );
  });
});

describe('order state machine', () => {
  it('never allows a terminal state to transition onward', () => {
    for (const state of OrderStateSchema.options) {
      if (!isTerminalOrderState(state)) continue;
      for (const target of OrderStateSchema.options) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it('does not allow a broadcast order to be cancelled', () => {
    expect(canTransition('broadcast', 'cancelled')).toBe(false);
  });

  it.each([
    ['pending_risk', 'simulating'],
    ['simulating', 'signing'],
    ['signing', 'broadcast'],
    ['broadcast', 'confirmed'],
  ] as const)('allows the happy-path step %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('never reaches signing without passing risk', () => {
    expect(canTransition('pending_risk', 'signing')).toBe(false);
    expect(canTransition('rejected_by_risk', 'signing')).toBe(false);
  });

  it('flags exactly the unresolved states for restart reconciliation', () => {
    const unresolved = OrderStateSchema.options.filter(requiresReconciliation);
    expect(unresolved).toStrictEqual(['signing', 'broadcast']);
  });
});