
import { describe, expect, it } from 'vitest';
import { ApprovalRequestSchema, DecisionRecordSchema, isApproved } from './decisions.js';

const recommendation = {
  recommendationId: '44444444-4444-4444-8444-444444444444',
  correlationId: '22222222-2222-4222-8222-222222222222',
  producedBy: 'agent-momentum',
  strategyId: 'momentum',
  producedAt: 1_700_000_000_000,
  action: 'enter',
  confidence: 0.7,
  provenance: ['pool:abc', 'tick:123'],
  rationale: 'momentum breakout confirmed',
};

const decisionBase = {
  decisionId: '55555555-5555-4555-8555-555555555555',
  correlationId: '22222222-2222-4222-8222-222222222222',
  decidedAt: 1_700_000_001_000,
  decidedBy: 'quantum-master-supervisor',
  inputs: [recommendation],
  confidenceMargin: 0.2,
  rationale: 'highest confidence with sufficient margin',
  signature: 'sig',
};

const HASH = 'a'.repeat(64);

describe('DecisionRecordSchema', () => {
  it('requires the genesis entry to omit previousHash', () => {
    const result = DecisionRecordSchema.safeParse({
      ...decisionBase,
      sequence: 0,
      outcome: 'rejected',
      previousHash: HASH,
    });
    expect(result.success).toBe(false);
  });

  it('requires non-genesis entries to chain', () => {
    const result = DecisionRecordSchema.safeParse({
      ...decisionBase,
      sequence: 1,
      outcome: 'rejected',
    });
    expect(result.success).toBe(false);
  });

  it('requires an accepted decision to name the selected recommendation', () => {
    const result = DecisionRecordSchema.safeParse({
      ...decisionBase,
      sequence: 1,
      outcome: 'accepted',
      previousHash: HASH,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-hex previousHash', () => {
    const result = DecisionRecordSchema.safeParse({
      ...decisionBase,
      sequence: 1,
      outcome: 'rejected',
      previousHash: 'Z'.repeat(64),
    });
    expect(result.success).toBe(false);
  });
});

describe('approval gating', () => {
  const requestBase = {
    requestId: '66666666-6666-4666-8666-666666666666',
    correlationId: '22222222-2222-4222-8222-222222222222',
    gate: 'any_action_affecting_wallets',
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    requestedBy: 'quantum-master-supervisor',
    summary: 'move 1 SOL to the execution wallet',
  };

  it('treats a pending request as not approved', () => {
    const request = ApprovalRequestSchema.parse({ ...requestBase, status: 'pending' });
    expect(isApproved(request)).toBe(false);
  });

  it('treats an approval recorded after the deadline as not approved', () => {
    const request = ApprovalRequestSchema.parse({
      ...requestBase,
      status: 'approved',
      decidedBy: 'jason',
      decidedAt: 1_700_000_120_000,
    });
    expect(isApproved(request)).toBe(false);
  });

  it('accepts an approval recorded before the deadline', () => {
    const request = ApprovalRequestSchema.parse({
      ...requestBase,
      status: 'approved',
      decidedBy: 'jason',
      decidedAt: 1_700_000_030_000,
    });
    expect(isApproved(request)).toBe(true);
  });

  it('requires a decided request to record the decider', () => {
    const result = ApprovalRequestSchema.safeParse({ ...requestBase, status: 'approved' });
    expect(result.success).toBe(false);
  });
});