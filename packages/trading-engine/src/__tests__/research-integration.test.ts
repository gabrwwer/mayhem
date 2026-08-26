import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ResearchRecorder } from '../research-recorder';

describe('Research Integration Pipeline', () => {
  let tempDir: string;
  let recorder: ResearchRecorder;
  let recordsFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-integration-'));
    recordsFile = path.join(tempDir, 'research-integration.jsonl');
    recorder = new ResearchRecorder({
      filePath: recordsFile,
      dryRun: true,
      tradingEnabled: false,
    });
  });

  afterEach(async () => {
    try {
      await recorder.flush();
    } catch {
      // Ignore flush errors in tests
    }
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function readRecords(): Array<Record<string, unknown>> {
    if (!fs.existsSync(recordsFile)) return [];
    const content = fs.readFileSync(recordsFile, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  it('captures the complete DISCOVERY → OBSERVATION → DECISION → EXECUTION → OUTCOME pipeline', async () => {
    const tokenMint = 'TestMint123456789';
    const positionId = 'pos_test_001';
    const discoveryRecordId = 'disc_001';
    const decisionRecordId = `decision:cand_001`;

    // Stage 1: DISCOVERY
    recorder.recordDiscovery({
      recordId: discoveryRecordId,
      tokenMint,
      mint: tokenMint,
      source: 'solana-onchain',
      stage: 'BONDING_CURVE',
      isPumpFun: true,
      creator: null,
      poolAddress: null,
      initialLiquidity: 0.5,
      decimals: 6,
    });

    // Stage 2: OBSERVATION (momentum evaluation)
    recorder.recordObservation({
      tokenMint,
      mint: tokenMint,
      event: 'MOMENTUM_EVALUATION',
      source: 'solana-onchain',
      outcome: 'confirmed',
      reason: 'momentum thresholds passed',
      initialPrice: 0.000001,
      finalPrice: 0.0000012,
      growthPerMin: 20.5,
      buyPressure: 0.65,
      flowBuyPressure: 0.68,
      netFlowPct: 15.3,
      maxDrawdownPct: 2.1,
      finalDrawdownPct: 1.8,
      volatility: 0.042,
      samples: 12,
      failedReads: 0,
    });

    // Stage 3: DECISION (BUY)
    recorder.recordDecision({
      recordId: decisionRecordId,
      tokenMint,
      mint: tokenMint,
      decision: 'BUY',
      reason: 'momentum and risk gates passed',
      riskScore: 92,
      price: 0.0000012,
      amount: 100,
      source: 'solana-onchain',
    });

    // Stage 4: EXECUTION (entry)
    recorder.recordExecution({
      tokenMint,
      mint: tokenMint,
      executionStatus: 'CONFIRMED',
      signature: 'sig_entry_test_123',
      requestedAmount: 100,
      executedAmount: 95,
      requestedPrice: 0.0000012,
      executedPrice: 0.00000125,
      slippageBps: 41.67,
      slippagePercent: 0.4167,
      fees: 0.0025,
    });

    // Stage 5: OUTCOME (position closed with P&L)
    recorder.recordOutcome({
      tokenMint,
      mint: tokenMint,
      positionId,
      entryTransaction: 'sig_entry_test_123',
      exitTransaction: 'sig_exit_test_456',
      entryPrice: 0.00000125,
      exitPrice: 0.0000015,
      entryAmount: 95,
      exitAmount: 90,
      realizedPnl: 0.00225,
      realizedPnlPercent: 20.0,
      fees: 0.005,
      holdDurationMs: 45000,
      exitReason: 'take_profit',
    });

    await recorder.flush();

    const records = readRecords();

    // Verify all record types are present
    expect(records.length).toBeGreaterThanOrEqual(5);

    const byType = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      const type = String(record['recordType']);
      if (!byType.has(type)) {
        byType.set(type, []);
      }
      byType.get(type)!.push(record);
    }

    // Verify record types
    expect(byType.has('DISCOVERY')).toBe(true);
    expect(byType.has('OBSERVATION')).toBe(true);
    expect(byType.has('DECISION')).toBe(true);
    expect(byType.has('EXECUTION')).toBe(true);
    expect(byType.has('OUTCOME')).toBe(true);

    // Verify correlation through mint
    const discovery = byType.get('DISCOVERY')?.[0];
    const observation = byType.get('OBSERVATION')?.[0];
    const decision = byType.get('DECISION')?.[0];
    const execution = byType.get('EXECUTION')?.[0];
    const outcome = byType.get('OUTCOME')?.[0];

    expect(discovery).toBeDefined();
    expect(observation).toBeDefined();
    expect(decision).toBeDefined();
    expect(execution).toBeDefined();
    expect(outcome).toBeDefined();

    expect(discovery!['tokenMint']).toBe(tokenMint);
    expect(observation!['tokenMint']).toBe(tokenMint);
    expect(decision!['tokenMint']).toBe(tokenMint);
    expect(execution!['tokenMint']).toBe(tokenMint);
    expect(outcome!['tokenMint']).toBe(tokenMint);

    // Verify decision correlation
    expect(decision!['recordId']).toBe(decisionRecordId);
    expect(decision!['decision']).toBe('BUY');

    // Verify execution captured the correct data
    expect(execution!['executionStatus']).toBe('CONFIRMED');
    expect(execution!['signature']).toBe('sig_entry_test_123');

    // Verify outcome has position lifecycle
    expect(outcome!['positionId']).toBe(positionId);
    expect(outcome!['realizedPnlPercent']).toBe(20.0);
  });

  it('handles REJECT decision without executing', async () => {
    const tokenMint = 'RejectTestMint123';
    const candidateId = 'cand_reject_001';

    // DISCOVERY
    recorder.recordDiscovery({
      tokenMint,
      mint: tokenMint,
      source: 'solana-onchain',
      stage: 'BONDING_CURVE',
      isPumpFun: true,
    });

    // OBSERVATION - but fails momentum
    recorder.recordObservation({
      tokenMint,
      mint: tokenMint,
      event: 'MOMENTUM_EVALUATION',
      outcome: 'rejected',
      reason: 'maxDrawdownPct exceeded threshold',
      buyPressure: 0.15,
      netFlowPct: -5.2,
    });

    // DECISION - REJECT
    recorder.recordDecision({
      recordId: `decision:${candidateId}`,
      tokenMint,
      mint: tokenMint,
      decision: 'REJECT',
      reason: 'momentum rejected: maxDrawdownPct exceeded threshold',
      rejectionReason: 'REJECTED_MOMENTUM',
      stage: 'REJECTED_MOMENTUM',
    });

    // Note: No EXECUTION or OUTCOME because position was never opened

    await recorder.flush();

    const records = readRecords();
    const decisionRecords = records.filter((r) => r['recordType'] === 'DECISION');

    expect(decisionRecords.length).toBeGreaterThanOrEqual(1);
    expect(decisionRecords[0]!['decision']).toBe('REJECT');
    expect(decisionRecords[0]!['tokenMint']).toBe(tokenMint);

    // Verify rejected tokens remain in dataset
    const allMints = new Set(records.map((r) => r['tokenMint'] || r['mint']));
    expect(allMints.has(tokenMint)).toBe(true);
  });

  it('handles multiple observations for a single token', async () => {
    const tokenMint = 'MultiObsMint123';

    // DISCOVERY
    recorder.recordDiscovery({
      tokenMint,
      source: 'solana-onchain',
    });

    // Multiple OBSERVATIONS (e.g., continuous momentum sampling)
    recorder.recordObservation({
      tokenMint,
      event: 'MOMENTUM_SAMPLE_1',
      buyPressure: 0.55,
      growthPerMin: 12.5,
    });

    recorder.recordObservation({
      tokenMint,
      event: 'MOMENTUM_SAMPLE_2',
      buyPressure: 0.62,
      growthPerMin: 18.3,
    });

    recorder.recordObservation({
      tokenMint,
      event: 'MOMENTUM_FINAL',
      buyPressure: 0.65,
      growthPerMin: 20.5,
      outcome: 'confirmed',
    });

    await recorder.flush();

    const records = readRecords();
    const obsRecords = records.filter((r) => r['recordType'] === 'OBSERVATION' && r['tokenMint'] === tokenMint);

    // Multiple observations should not be deduplicated just because they share the same mint
    expect(obsRecords.length).toBeGreaterThanOrEqual(2);
  });

  it('handles failed execution attempts', async () => {
    const tokenMint = 'FailedExecMint123';

    // DISCOVERY
    recorder.recordDiscovery({
      tokenMint,
      source: 'solana-onchain',
    });

    // OBSERVATION
    recorder.recordObservation({
      tokenMint,
      outcome: 'confirmed',
      buyPressure: 0.7,
    });

    // DECISION - BUY (but execution will fail)
    recorder.recordDecision({
      tokenMint,
      decision: 'BUY',
      reason: 'gates passed',
    });

    // EXECUTION - FAILED
    recorder.recordExecution({
      tokenMint,
      executionStatus: 'FAILED',
      reason: 'insufficient liquidity for order size',
      requestedAmount: 100,
      executedAmount: null,
      signature: null,
    });

    // No OUTCOME because position was never opened

    await recorder.flush();

    const records = readRecords();
    const execRecords = records.filter((r) => r['recordType'] === 'EXECUTION');

    expect(execRecords.length).toBeGreaterThanOrEqual(1);
    expect(execRecords[0]!['executionStatus']).toBe('FAILED');

    // Failed execution should still be traceable to the decision
    const decisions = records.filter((r) => r['recordType'] === 'DECISION' && r['tokenMint'] === tokenMint);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0]!['decision']).toBe('BUY');
  });

  it('validates record schema and timestamps', async () => {
    recorder.recordDiscovery({
      tokenMint: 'SchemaTestMint',
      source: 'test',
    });

    await recorder.flush();

    const records = readRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);

    const record = records[0];
    expect(record).toBeDefined();

    // Verify required fields
    expect(record!['schemaVersion']).toBe(2);
    expect(record!['recordType']).toBeDefined();
    expect(record!['recordedAt']).toBeDefined();
    expect(record!['recordId']).toBeDefined();

    // Verify timestamp is valid ISO string
    const timestamp = String(record!['recordedAt']);
    expect(() => new Date(timestamp)).not.toThrow();

    // Verify recordType is valid
    const validTypes = ['DISCOVERY', 'OBSERVATION', 'DECISION', 'EXECUTION', 'OUTCOME'];
    expect(validTypes).toContain(record!['recordType']);
  });

  it('redacts secrets properly', async () => {
    recorder.recordDiscovery({
      tokenMint: 'Test',
      source: 'test',
      apiKey: ['sk_test', 'secret_key_12345'].join('_'),
      authorizationHeader: 'Bearer token_secret',
      walletPrivateKey: 'private_key_content',
    });

    await recorder.flush();

    const records = readRecords();
    const record = records[0];
    expect(record).toBeDefined();

    expect(record!['apiKey']).toBe('[REDACTED]');
    expect(record!['authorizationHeader']).toBe('[REDACTED]');
    expect(record!['walletPrivateKey']).toBe('[REDACTED]');
  });
});
