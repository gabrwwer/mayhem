import { ResearchRecorder } from './packages/trading-engine/src/research-recorder';
import { PriceLifecycleEvent } from './packages/trading-engine/src/research-metrics';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test basic functionality
async function testBasicFunctionality() {
  console.log('Testing basic research recorder functionality...');

  const tmpFile = path.join(process.cwd(), `test-research-${Date.now()}.jsonl`);
  const recorder = new ResearchRecorder({
    filePath: tmpFile,
    dryRun: true,
    tradingEnabled: false,
  });

  // Test 1: Record discovery
  recorder.recordDiscovery({
    event: 'TOKEN_DISCOVERED',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    source: 'test-source',
    name: 'Test Token',
    symbol: 'TST',
    decimals: 6,
    initialLiquidity: 10.5,
    isPumpFun: true,
  });

  // Test 2: Record observation
  recorder.recordObservation({
    event: 'CONTINUOUS_OBSERVATION',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    observedAt: Date.now(),
    price: 1.25,
    volumeData: {
      volume1m: 5.2,
      volume5m: 25.6,
      buyVolume: 15.3,
      sellVolume: 10.3,
      buyVolumePct: 59.8,
      sellVolumePct: 40.2,
    }
  });

  // Test 3: Record decision
  recorder.recordDecision({
    event: 'BUY_DECISION',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    decision: 'BUY',
    reason: 'Test decision',
    price: 1.25,
    amount: 10.0,
    momentumScore: 75.5,
    volumeScore: 80.0,
    liquidityScore: 70.0,
    overallScore: 75.2,
  });

  // Test 4: Record execution
  recorder.recordExecution({
    event: 'EXECUTION_ATTEMPT',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    executionStatus: 'CONFIRMED',
    signature: 'test_signature_123',
    requestedAmount: 10.0,
    executedAmount: 9.8,
    requestedPrice: 1.25,
    executedPrice: 1.24,
    slippageBps: -80, // 0.8% better than expected
    slippagePercent: -0.8,
    fees: 0.001,
    timestamp: new Date().toISOString(),
  });

  // Test 5: Record lifecycle
  const lifecycle: PriceLifecycleEvent = {
    observationTime: Date.now() - 10000,
    observationPrice: 1.0,
    signalTime: Date.now() - 5000,
    signalPrice: 1.1,
    qualificationTime: Date.now() - 2000,
    qualifiedEntryPrice: 1.15,
    executionTime: Date.now() - 1000,
    executionPrice: 1.14,
  };

  recorder.recordLifecycle(
    'TEST_MINT_123',
    lifecycle,
    true,
    'position-123',
    [
      { timestamp: Date.now() - 10000, price: 1.0 },
      { timestamp: Date.now() - 5000, price: 1.1 },
      { timestamp: Date.now() - 2000, price: 1.15 },
      { timestamp: Date.now() - 1000, price: 1.14 },
      { timestamp: Date.now(), price: 1.16 },
    ]
  );

  // Test 6: Record outcome
  recorder.recordOutcome({
    event: 'POSITION_OUTCOME',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    positionId: 'position-123',
    entryPrice: 1.15,
    exitPrice: 1.16,
    quantity: 9.8,
    entryNotionalSol: 11.27,
    exitNotionalSol: 11.37,
    grossPnlSol: 0.1,
    feesSol: 0.002,
    netPnlSol: 0.098,
    netPnlPercent: 8.5,
    exitReason: 'TP',
    holdDurationMs: 9000,
    maxFavorableExcursion: 6.0,
    maxAdverseExcursion: 2.0,
    config: {
      dryRun: true,
      tradingEnabled: false,
    }
  });

  // Test 7: Record specialized events
  recorder.recordLpInitialization({
    event: 'LP_INITIALIZATION_EVENT',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    lpInitializedAt: Date.now() - 8000,
    initialLiquiditySol: 10.5,
    initialLiquidityUsd: 18500.0,
    poolAddress: 'TEST_POOL_123',
  });

  recorder.recordGraduation({
    event: 'GRADUATION_EVENT',
    tokenMint: 'TEST_MINT_123',
    mint: 'TEST_MINT_123',
    graduationAt: Date.now() - 1000,
    preGraduationLiquiditySol: 10.5,
    postGraduationLiquiditySol: 50.0,
    preGraduationVolumeSol: 100.0,
    postGraduationVolumeSol: 500.0,
    graduationClassification: 'GRADUATION_SUCCESS',
  });

  await recorder.flush();

  // Read and verify the records
  const content = fs.readFileSync(tmpFile, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);

  console.log(`Generated ${lines.length} research records`);

  // Parse each line as JSON
  const records = lines.map(line => JSON.parse(line));

  // Verify we have the expected number of records
  console.log(`Expected 8 records, got ${records.length}`);

  // Check record types
  const recordTypes = records.map(r => r.recordType);
  console.log('Record types:', recordTypes);

  // Enhanced records should have schemaVersion 2
  const schemaVersions = records.map(r => r.schemaVersion);
  console.log('Schema versions:', schemaVersions);

  // Clean up
  fs.unlinkSync(tmpFile);

  console.log('Basic functionality test completed successfully!');
  return true;
}

// Run the test
testBasicFunctionality()
  .then(() => {
    console.log('✅ All tests passed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });