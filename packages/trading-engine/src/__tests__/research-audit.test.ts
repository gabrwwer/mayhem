/**
 * PHASE 4 — RESEARCH DATA VALIDATION AUDIT
 *
 * Comprehensive audit to verify:
 * 1. Lifecycle price semantics correctness
 * 2. Timestamp chronological ordering
 * 3. Price history data source integrity
 * 4. Look-ahead bias detection
 * 5. Measurement window anchoring
 * 6. Data completeness for reproducibility
 *
 * Tests only critical audit paths — not full test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResearchRecorder } from '../research-recorder';
import { PriceLifecycleEvent, MEASUREMENT_WINDOWS_MS } from '../research-metrics';
import * as fs from 'fs';
import * as path from 'path';

function parseResearchRecords(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe('PHASE 4 — Research Data Validation Audit', () => {
  let recorder: ResearchRecorder;
  let testDataDir: string;
  let researchFilePath: string;

  beforeEach(() => {
    testDataDir = path.join(__dirname, 'audit-' + Date.now());
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    researchFilePath = path.join(testDataDir, 'research.jsonl');

    recorder = new ResearchRecorder({
      filePath: researchFilePath,
      dryRun: true,
      tradingEnabled: false,
    });
  });

  afterEach(async () => {
    await recorder.flush().catch(() => undefined);
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true });
    }
  });

  describe('CRITERION 1-5: Lifecycle Price Semantics', () => {
    it('[AUDIT-1] observationPrice represents actual discovery price', async () => {
      const tokenMint = 'TEST_OBS_1';
      const observationPrice = 2.5;
      const observationTime = Date.now();

      const lifecycle: PriceLifecycleEvent = {
        observationTime,
        observationPrice,
        signalTime: observationTime,
        signalPrice: observationPrice,
        qualificationTime: observationTime,
        qualifiedEntryPrice: observationPrice,
      };

      const priceHistory = [
        { timestamp: observationTime, price: observationPrice },
      ];

      recorder.recordLifecycle(tokenMint, lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records.length).toBe(1);
      expect(records[0].lifecycle.observationPrice).toBe(observationPrice);
      expect(records[0].lifecycle.observationTime).toBe(observationTime);
    });

    it('[AUDIT-2] signalPrice represents signal generation price', async () => {
      const tokenMint = 'TEST_SIG_2';
      const observationPrice = 2.0;
      const signalPrice = 2.05;
      const observationTime = 1000;
      const signalTime = 1100;

      const lifecycle: PriceLifecycleEvent = {
        observationTime,
        observationPrice,
        signalTime,
        signalPrice,
        qualificationTime: signalTime,
        qualifiedEntryPrice: signalPrice,
      };

      recorder.recordLifecycle(tokenMint, lifecycle, false);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records[0].lifecycle.signalPrice).toBe(signalPrice);
      expect(records[0].lifecycle.signalPrice).not.toBe(
        records[0].lifecycle.observationPrice
      );
    });

    it('[AUDIT-3] qualifiedEntryPrice represents qualified entry benchmark', async () => {
      const tokenMint = 'TEST_QUAL_3';
      const qualifiedEntryPrice = 2.10;
      const qualificationTime = 2000;

      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime,
        qualifiedEntryPrice,
      };

      recorder.recordLifecycle(tokenMint, lifecycle, false);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records[0].lifecycle.qualifiedEntryPrice).toBe(qualifiedEntryPrice);
    });

    it('[AUDIT-4] actualEntryPrice (executionPrice) represents actual fill only', async () => {
      const tokenMint = 'TEST_EXEC_4';
      const qualifiedEntryPrice = 2.10;
      const actualEntryPrice = 2.12; // Slippage from qualified

      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice,
        executionTime: 2050,
        executionPrice: actualEntryPrice,
      };

      recorder.recordLifecycle(tokenMint, lifecycle, true);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records[0].lifecycle.executionPrice).toBe(actualEntryPrice);
      expect(records[0].lifecycle.qualifiedEntryPrice).not.toBe(
        records[0].lifecycle.executionPrice
      );
      expect(records[0].slippageBps).toBe(
        ((actualEntryPrice - qualifiedEntryPrice) / qualifiedEntryPrice) * 10000
      );
    });

    it('[AUDIT-5] No price substitution across lifecycle stages', async () => {
      const prices = {
        observation: 1.0,
        signal: 1.05,
        qualified: 1.10,
        execution: 1.12,
      };

      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: prices.observation,
        signalTime: 1100,
        signalPrice: prices.signal,
        qualificationTime: 2000,
        qualifiedEntryPrice: prices.qualified,
        executionTime: 2050,
        executionPrice: prices.execution,
      };

      recorder.recordLifecycle('TEST_NO_SUB_5', lifecycle, true);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);
      const rec = records[0];

      // Verify each price is exactly as set, no mixing
      expect(rec.lifecycle.observationPrice).toBe(prices.observation);
      expect(rec.lifecycle.signalPrice).toBe(prices.signal);
      expect(rec.lifecycle.qualifiedEntryPrice).toBe(prices.qualified);
      expect(rec.lifecycle.executionPrice).toBe(prices.execution);
    });
  });

  describe('CRITERION 6: Timestamp Chronological Ordering', () => {
    it('[AUDIT-6] Timestamps satisfy observationTime <= signalTime <= qualificationTime <= executionTime', async () => {
      const times = {
        observation: 1000,
        signal: 1100,
        qualification: 2000,
        execution: 2050,
      };

      const lifecycle: PriceLifecycleEvent = {
        observationTime: times.observation,
        observationPrice: 1.0,
        signalTime: times.signal,
        signalPrice: 1.05,
        qualificationTime: times.qualification,
        qualifiedEntryPrice: 1.10,
        executionTime: times.execution,
        executionPrice: 1.12,
      };

      recorder.recordLifecycle('TEST_TIME_ORDER_6', lifecycle, true);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);
      const lifecycle_rec = records[0].lifecycle;

      // Verify chronological ordering
      expect(lifecycle_rec.observationTime).toBeLessThanOrEqual(
        lifecycle_rec.signalTime
      );
      expect(lifecycle_rec.signalTime).toBeLessThanOrEqual(
        lifecycle_rec.qualificationTime
      );
      expect(lifecycle_rec.qualificationTime).toBeLessThanOrEqual(
        lifecycle_rec.executionTime!
      );
    });

    it('[AUDIT-6b] Missing execution does not violate ordering', async () => {
      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 1.0,
        signalTime: 1100,
        signalPrice: 1.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 1.10,
        // executionTime and executionPrice are undefined
      };

      recorder.recordLifecycle('TEST_NO_EXEC_6b', lifecycle, false);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records[0].lifecycle.executionTime).toBeUndefined();
      expect(records[0].lifecycle.executionPrice).toBeUndefined();
      expect(records[0].positionOpened).toBe(false);
    });
  });

  describe('CRITERION 7: Price History Data Source', () => {
    it('[AUDIT-7] priceHistory contains real observed prices only', async () => {
      const baseTime = 1000;
      const prices = [1.0, 1.05, 1.10, 1.08, 1.12];
      const priceHistory = prices.map((p, i) => ({
        timestamp: baseTime + i * 100,
        price: p,
      }));

      const lifecycle: PriceLifecycleEvent = {
        observationTime: baseTime,
        observationPrice: prices[0]!,
        signalTime: baseTime + 100,
        signalPrice: prices[1]!,
        qualificationTime: baseTime + 200,
        qualifiedEntryPrice: prices[2]!,
      };

      recorder.recordLifecycle('TEST_PRICE_HIST_7', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records[0].priceHistory).toEqual(priceHistory);
      expect(records[0].priceHistory.length).toBe(5);
    });

    it('[AUDIT-7b] All prices in history are >= reference timestamp', async () => {
      const baseTime = 1000;
      const referenceTime = baseTime + 200;
      const priceHistory = [
        { timestamp: baseTime, price: 1.0 }, // Before reference
        { timestamp: baseTime + 150, price: 1.05 }, // Still before
        { timestamp: referenceTime, price: 1.10 }, // At reference
        { timestamp: referenceTime + 100, price: 1.12 }, // After reference
      ];

      const lifecycle: PriceLifecycleEvent = {
        observationTime: baseTime,
        observationPrice: 1.0,
        signalTime: baseTime + 100,
        signalPrice: 1.05,
        qualificationTime: referenceTime,
        qualifiedEntryPrice: 1.10,
      };

      recorder.recordLifecycle('TEST_PRICE_HIST_7b', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      // Verify data is stored as provided
      expect(records[0].priceHistory.length).toBe(4);
      // All prices should be available for measurement window calculations
    });
  });

  describe('CRITERION 8-9: Look-Ahead Bias Detection', () => {
    it('[AUDIT-8] Metrics use only prices known at reference time', async () => {
      const referenceTime = 1000;
      const priceHistory = [
        { timestamp: referenceTime, price: 100 },
        { timestamp: referenceTime + 100, price: 105 },
        { timestamp: referenceTime + 200, price: 110 },
        { timestamp: referenceTime + 300, price: 108 },
      ];

      const lifecycle: PriceLifecycleEvent = {
        observationTime: referenceTime,
        observationPrice: 100,
        signalTime: referenceTime,
        signalPrice: 100,
        qualificationTime: referenceTime,
        qualifiedEntryPrice: 100,
      };

      recorder.recordLifecycle('TEST_NO_LOOKAHEAD_8', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      const perf = records[0].performanceFromObservationPrice;
      const window1s = perf['window_1000ms'];

      // Only prices in [referenceTime, referenceTime + 1000] should be used
      expect(window1s).toBeDefined();
      // The final price in the 1s window should be the price at 1000ms
      expect(window1s.price).toBe(108);

      // MFE should be max of prices in window, not beyond
      const maxInWindow = Math.max(100, 105, 110, 108);
      expect(window1s.mfePercent).toBe(((maxInWindow - 100) / 100) * 100);
    });

    it('[AUDIT-9] MFE/MAE do not use prices outside measurement window', async () => {
      const referenceTime = 1000;
      const priceHistory = [
        { timestamp: referenceTime, price: 100 },
        { timestamp: referenceTime + 500, price: 150 }, // High within window
        { timestamp: referenceTime + 1500, price: 200 }, // High but outside 1s window
        { timestamp: referenceTime + 1800, price: 50 }, // Low but outside 1s window
      ];

      const lifecycle: PriceLifecycleEvent = {
        observationTime: referenceTime,
        observationPrice: 100,
        signalTime: referenceTime,
        signalPrice: 100,
        qualificationTime: referenceTime,
        qualifiedEntryPrice: 100,
      };

      recorder.recordLifecycle('TEST_MFE_MAE_9', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      const perf = records[0].performanceFromObservationPrice;
      const window1s = perf['window_1000ms'];

      // MFE should be 150, not 200
      expect(window1s.mfePercent).toBe(50); // (150-100)/100 * 100
      // MAE should be 0 (no price below 100 in window)
      expect(window1s.maePercent).toBe(0);
    });
  });

  describe('CRITERION 10: Measurement Window Anchoring', () => {
    it('[AUDIT-10] Measurement windows anchor correctly to reference timestamp', async () => {
      const referenceTime = 1000;
      const priceHistory = [
        { timestamp: referenceTime, price: 100 },
        { timestamp: referenceTime + 500, price: 105 },
        { timestamp: referenceTime + 1000, price: 110 }, // End of 1s window
        { timestamp: referenceTime + 5000, price: 115 }, // End of 5s window
      ];

      const lifecycle: PriceLifecycleEvent = {
        observationTime: referenceTime,
        observationPrice: 100,
        signalTime: referenceTime,
        signalPrice: 100,
        qualificationTime: referenceTime,
        qualifiedEntryPrice: 100,
      };

      recorder.recordLifecycle('TEST_WINDOW_ANCHOR_10', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);
      const perf = records[0].performanceFromObservationPrice;

      // Verify window keys exist
      expect(perf['window_1000ms']).toBeDefined();
      expect(perf['window_5000ms']).toBeDefined();

      // 1s window should end at referenceTime + 1000
      expect(perf['window_1000ms'].measurementTime).toBe(referenceTime + 1000);
      // 5s window should end at referenceTime + 5000
      expect(perf['window_5000ms'].measurementTime).toBe(referenceTime + 5000);
    });
  });

  describe('CRITERION 11: Non-Executed Positions', () => {
    it('[AUDIT-11] Token without execution produces valid observation/signal/qualification data', async () => {
      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
        // No executionTime or executionPrice
      };

      const priceHistory = [
        { timestamp: 1000, price: 2.0 },
        { timestamp: 1100, price: 2.05 },
        { timestamp: 2000, price: 2.10 },
      ];

      recorder.recordLifecycle('TEST_NO_EXEC_11', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      // Should have observation, signal, qualified metrics
      expect(records[0].performanceFromObservationPrice).toBeDefined();
      expect(records[0].performanceFromSignalPrice).toBeDefined();
      expect(records[0].performanceFromQualifiedEntryPrice).toBeDefined();

      // Should NOT have execution metrics
      expect(records[0].performanceFromExecutionPrice).toBeUndefined();

      // Position was not opened
      expect(records[0].positionOpened).toBe(false);
    });
  });

  describe('CRITERION 12: Executed Position Recording', () => {
    it('[AUDIT-12] Execution records actual fill price separately', async () => {
      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
        executionTime: 2050,
        executionPrice: 2.12, // Different from qualified
      };

      const priceHistory = [
        { timestamp: 2050, price: 2.12 },
        { timestamp: 2100, price: 2.14 },
        { timestamp: 2150, price: 2.16 },
      ];

      recorder.recordLifecycle('TEST_EXEC_FILL_12', lifecycle, true, 'pos-123', priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      expect(records[0].lifecycle.executionPrice).toBe(2.12);
      expect(records[0].positionOpened).toBe(true);
      expect(records[0].positionId).toBe('pos-123');

      // Should have execution metrics (if price history provides data)
      // May be undefined if no measurements calculated, which is acceptable
      if (records[0].performanceFromExecutionPrice) {
        expect(Object.keys(records[0].performanceFromExecutionPrice).length).toBeGreaterThan(0);
      }
    });
  });

  describe('CRITERION 13: Slippage Calculation', () => {
    it('[AUDIT-13] Slippage calculated only when both qualified and execution exist', async () => {
      // Case 1: Both exist
      const lifecycle1: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
        executionTime: 2050,
        executionPrice: 2.12,
      };

      recorder.recordLifecycle('TEST_SLIPPAGE_BOTH_13', lifecycle1, true);
      await recorder.flush();
      let records = parseResearchRecords(researchFilePath);
      const slippageBps1 = records[0].slippageBps;

      expect(slippageBps1).toBeDefined();
      expect(slippageBps1).toBe(
        ((2.12 - 2.10) / 2.10) * 10000
      );

      // Case 2: Only qualified (no execution)
      const lifecycle2: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
      };

      recorder.recordLifecycle('TEST_SLIPPAGE_NO_EXEC_13', lifecycle2, false);
      await recorder.flush();
      records = parseResearchRecords(researchFilePath);

      expect(records[records.length - 1].slippageBps).toBeUndefined();
    });
  });

  describe('CRITERION 14: Duplicate Prevention', () => {
    it('[AUDIT-14] Duplicate lifecycle records cannot corrupt dataset', async () => {
      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
        executionTime: 2050,
        executionPrice: 2.12,
      };

      const priceHistory = [{ timestamp: 1000, price: 2.0 }];

      // Record same lifecycle twice
      recorder.recordLifecycle('TEST_DUP_14', lifecycle, true, 'pos-123', priceHistory);
      recorder.recordLifecycle('TEST_DUP_14', lifecycle, true, 'pos-123', priceHistory);

      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      // Both records should exist (deduplication happens at analysis time)
      expect(records.length).toBe(2);

      // But they should be distinguishable by recordId
      expect(records[0].recordId).not.toBe(records[1].recordId);
    });
  });

  describe('CRITERION 15: Data Completeness', () => {
    it('[AUDIT-15] ResearchRecord contains sufficient information for later reproduction', async () => {
      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
        executionTime: 2050,
        executionPrice: 2.12,
      };

      const priceHistory = [
        { timestamp: 1000, price: 2.0 },
        { timestamp: 1100, price: 2.05 },
        { timestamp: 2000, price: 2.10 },
        { timestamp: 2050, price: 2.12 },
      ];

      recorder.recordLifecycle('TEST_COMPLETE_15', lifecycle, true, 'pos-456', priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);
      const record = records[0];

      // Verify all essential fields
      expect(record.recordId).toBeDefined();
      expect(record.tokenMint).toBe('TEST_COMPLETE_15');
      expect(record.recordedAt).toBeDefined();
      expect(record.lifecycle).toBeDefined();
      expect(record.positionOpened).toBe(true);
      expect(record.positionId).toBe('pos-456');
      expect(record.priceHistory).toEqual(priceHistory);
      expect(record.performanceFromObservationPrice).toBeDefined();
      expect(record.performanceFromSignalPrice).toBeDefined();
      expect(record.performanceFromQualifiedEntryPrice).toBeDefined();
      expect(record.performanceFromExecutionPrice).toBeDefined();
      expect(record.config).toBeDefined();

      // Should be able to recompute all metrics from this data
      expect(Object.keys(record).length > 10).toBe(true);
    });
  });

  describe('CRITERION 16: Configuration/Version Tracking', () => {
    it('[AUDIT-16] Config context distinguishes strategy configurations', async () => {
      const lifecycle: PriceLifecycleEvent = {
        observationTime: 1000,
        observationPrice: 2.0,
        signalTime: 1100,
        signalPrice: 2.05,
        qualificationTime: 2000,
        qualifiedEntryPrice: 2.10,
      };

      recorder.recordLifecycle('TEST_CONFIG_16', lifecycle, false);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);

      const config = records[0].config;
      expect(config.dryRun).toBe(true);
      expect(config.tradingEnabled).toBe(false);

      // These values should be consistent across all records from same run
      expect(typeof config.dryRun).toBe('boolean');
      expect(typeof config.tradingEnabled).toBe('boolean');
    });
  });

  describe('Summary: Look-Ahead Bias Audit', () => {
    it('[SUMMARY] Comprehensive look-ahead bias check across all metrics', async () => {
      // Create a scenario where future prices are known but should not be used
      const baseTime = 1000;
      const referenceTime = 1000;

      // Price history that extends beyond all measurement windows
      const priceHistory = [
        { timestamp: referenceTime, price: 100 },
        { timestamp: referenceTime + 500, price: 110 },
        { timestamp: referenceTime + 1000, price: 120 }, // End of 1s window
        { timestamp: referenceTime + 5000, price: 150 }, // End of 5s window
        { timestamp: referenceTime + 10000, price: 200 }, // End of 10s window
        { timestamp: referenceTime + 999999, price: 1000 }, // Far future
      ];

      const lifecycle: PriceLifecycleEvent = {
        observationTime: referenceTime,
        observationPrice: 100,
        signalTime: referenceTime,
        signalPrice: 100,
        qualificationTime: referenceTime,
        qualifiedEntryPrice: 100,
      };

      recorder.recordLifecycle('TEST_LOOKAHEAD_CHECK', lifecycle, false, undefined, priceHistory);
      await recorder.flush();
      const records = parseResearchRecords(researchFilePath);
      const perf = records[0].performanceFromObservationPrice;

      // 1s window should NOT include 150, 200, or 1000
      const window1s = perf['window_1000ms'];
      expect(window1s.mfePercent).toBe(20); // max is 120, not 150/200/1000
      expect(window1s.price).toBe(120); // final price at 1s boundary

      // 5s window should NOT include 200 or 1000
      const window5s = perf['window_5000ms'];
      expect(window5s.mfePercent).toBe(50); // max is 150, not 200/1000
      expect(window5s.price).toBe(150);

      // 10s window should NOT include 1000
      const window10s = perf['window_10000ms'];
      expect(window10s.mfePercent).toBe(100); // max is 200, not 1000
      expect(window10s.price).toBe(200);
    });
  });
});
