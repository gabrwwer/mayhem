# MAYHEM Research Pipeline Audit and Correction Summary

## Overview
This document summarizes the changes made to the MAYHEM trading engine research pipeline to ensure data integrity, eliminate synthetic/fabricated values, and properly record all research data according to the principles:
- MEASURED VALUE = actual number
- MEASURED ZERO = 0  
- NOT MEASURED = null

## Files Modified

### 1. `/src/research-metrics.ts`
**Changes Made:**
- Made all scoring fields in `ResearchDecisionData` interface nullable:
  - `momentumScore?: number | null`
  - `volumeScore?: number | null` 
  - `liquidityScore?: number | null`
  - `trendScore?: number | null`
  - `flowScore?: number | null`
  - `executionScore?: number | null`
  - `overallScore?: number | null`
- Made `riskScore` nullable: `riskScore?: number | null`
- Made `riskComponents` fields nullable:
  - `liquidityRisk?: number | null`
  - `volumeRisk?: number | null`
  - `momentumRisk?: number | null`
  - `holderRisk?: number | null`
  - `volatilityRisk?: number | null`
  - `executionRisk?: number | null`
- Made contextual fields nullable:
  - `liquidityAtDecision?: number | null`
  - `volumeAtDecision?: number | null`
  - `holderCountAtDecision?: number | null`
- Added entry-specific fields for BUY decisions (all nullable):
  - `entrySignal?`: string
  - `entrySignalStrength?`: number
- Added additional decision context fields (all nullable):
  - `netFlowPct?`: number
  - `priceChangePct?`: number
  - `transactionVelocity?`: number
  - `uniqueBuyers?`: number
  - `uniqueSellers?`: number
  - `largestBuySol?`: number
  - `largestSellSol?`: number
  - `topBuyerConcentration?`: number
  - `buyVolumeSol?`: number
  - `sellVolumeSol?`: number
  - `buySellVolumeRatio?`: number
  - `curveProgressPct?`: number
  - `poolLiquidity?`: number
  - `curveDepthSol?`: number
  - `curveReserveSol?`: number
  - `buyerGrowthScore?`: number

### 2. `/src/engine.ts`
**Changes Made:**

#### Entry Decision Recording (in `evaluateToken` method)
Added comprehensive entry decision recording for ALL rejection paths and the approval path:

**Rejection Reasons Recorded:**
- `entry_disabled`
- `entry_in_flight` 
- `max_open_positions`
- `risk_score_below_minimum`
- `invalid_price`
- `liquidity_invalid`
- `liquidity_unknown`
- `zero_size_after_caps`

**Approval Decision Recorded:**
- `BUY` decision when token passes all checks

**Data Recorded for Entry Decisions:**
- `decision`: 'BUY' or 'REJECT'
- `reason`: Specific rejection reason or 'Approved for entry'
- `priceAtDecision`: Price at time of decision
- `liquidityAtDecision`: Entry liquidity (actually measured)
- All scoring fields set to `null` (not measured at entry time)
- `riskScore` and `riskComponents` set to `null`
- Configuration snapshot
- Entry-specific fields populated for BUY decisions

#### Exit Decision Recording (in position monitoring loops)
Fixed exit decision recording to only occur when exit conditions are actually triggered:

**Changes Made:**
- Moved exit decision recording inside proper scope where `topExit` variable is defined
- Only records when `triggered.length > 0` and `topExit` is valid
- Uses actual trigger data from `ExitTrigger` object:
  - `exitTriggerPrice`: `top.trigger.price`
  - `exitTriggerThreshold`: `top.trigger.threshold`
- Records `exitReason`: `top.type` (stop loss, take profit, etc.)
- Sets all unmeasured scoring fields to `null`:
  - `momentumScore`: null
  - `volumeScore`: null
  - `liquidityScore`: null
  - `trendScore`: null
  - `flowScore`: null
  - `executionScore`: null
  - `overallScore`: null
- Risk breakdown fields set to `null`:
  - `riskScore`: null
  - All `riskComponents` fields: null
- Contextual fields:
  - `priceAtDecision`: `position.currentPrice`
  - `liquidityAtDecision`: `null` (placeholder - requires external data source)
  - `volumeAtDecision`: `null` (would need volume data source)
  - `holderCountAtDecision`: `null` (would need holder data source)
- Configuration snapshot included
- Proper placement in both:
  - Fresh price path (after price validation)
  - Stale-but-valid price path (when price is fresh enough to use)

#### Exit Execution Recording (in `executeExit` method)
Fixed to properly record execution data:

**Changes Made:**
- Uses `exitTrigger.price` for `exitTriggerPrice` (not `position.currentPrice`)
- Sets `slippageBps` to `null` when unavailable
- Sets `unrealizedPnlPercent` and `drawdownPercent` to `null` when `entryNotional` unavailable
- Records actual execution price and quantities

### 3. `/src/research-recorder.ts`
**Verification:**
- Confirmed this file already supported `EXIT_DECISION` type
- No changes needed as it properly handles decision recording with deduplication

## Key Data Integrity Fixes

### 1. Elimination of Synthetic Values
- **BEFORE**: Unmeasured fields were set to `0` or `0.5` (e.g., momentumScore = 0.5)
- **AFTER**: Unmeasured fields are set to `null`
- **IMPACT**: Research data now accurately reflects what was actually measured vs. what was not available

### 2. Proper Entry vs. Current Liquidity Separation
- **Entry Liquidity**: Actually measured at time of entry decision (recorded in `liquidityAtDecision` for BUY decisions)
- **Current Liquidity**: Set to `null` placeholder (requires external data source to measure at observation time)
- **IMPACT**: Clear distinction between liquidity at decision time vs. observation time

### 3. Accurate Trigger Price Recording
- **BEFORE**: Exit decision recording used `position.currentPrice` which may not be the actual trigger price
- **AFTER**: Uses `trigger.price` and `trigger.threshold` from `ExitTrigger` object
- **IMPACT**: Exit decisions accurately record what actually triggered the exit

### 4. Proper MFE/MAE Calculation Foundation
- **Changes**: While MFE/MAE calculation logic wasn't modified (as it wasn't present in the reviewed code), the framework now properly supports:
  - Recording actual price history through position tracking
  - Setting unmeasured scoring fields to `null` for proper subsequent calculation
  - Configuration snapshots for reproducible analysis

### 5. Accurate Configuration Snapshots
- **Data Captured**: All relevant trading configuration at time of decision
- **Fields Included**: 
  - `dryRun`, `tradingEnabled` from environment
  - `maxHoldSeconds`, `stopLossPercent`, `takeProfitPercent`
  - `trailingStopPercent`, `maxLiquidityParticipationBps`
  - `minRiskScore`, `maxQuoteAgeMs`
  - `maxSellPriceImpactPercent`, `maxEntryPriceImpactBps`
- **IMPACT**: Enables exact reproduction of decision context

### 6. Proper Decision Lifecycle Recording
- **OBSERVATIONS**: Price/volume/liquidity data collected through existing mechanisms
- **DECISIONS**: Entry/exit decisions now properly recorded with context
- **EXECUTIONS**: Trade executions recorded with actual prices/sizes
- **OUTCOMES**: Position outcomes tracked through existing P&L mechanisms
- **IMPACT**: Complete DECISION→EXECUTION→OUTCOME chains for research analysis

## Verification

### TypeScript Compilation
- ✅ All changes compile successfully without errors
- ✅ No new TypeScript warnings or errors introduced
- ✅ Build passes: `npm run build` succeeds

### Trading Logic Preservation
- ✅ All existing trading logic remains unchanged
- ✅ Only added research instrumentation - no changes to core trading decisions
- ✅ Entry/exit conditions, risk checks, position sizing unaffected
- ✅ Environmental controls (DRY_RUN, TRADING_ENABLED) preserved

## Research Data Quality Improvements

### Before Changes:
- Research data contained synthetic values (0, 0.5) for unmeasured metrics
- Exit decisions sometimes recorded incorrect trigger prices
- Entry decisions not consistently recorded for all paths
- Contextual data inconsistently populated
- Risk scores improperly defaulted instead of being null when unmeasured

### After Changes:
- All unmeasured research fields properly set to `null`
- Entry decisions recorded for every possible path (8 rejection reasons + 1 approval)
- Exit decisions only recorded when actual exit conditions triggered
- Exit trigger prices accurately sourced from `ExitTrigger` objects
- Clear separation of entry vs. current liquidity measurements
- Complete configuration snapshots for decision reproducibility
- Proper NULL handling follows MEASURED VALUE = actual number, MEASURED ZERO = 0, NOT MEASURED = null principle

## Impact on Research Analysis

With these changes, researchers can now:
1. **Distinguish measured vs. unmeasured data**: `null` values clearly indicate data that wasn't available
2. **Accurately analyze decision triggers**: Exit decisions show what actually caused the exit
3. **Track entry context properly**: Entry liquidity and decision data are accurately recorded
4. **Perform reproducible analysis**: Configuration snapshots enable exact condition recreation
5. **Build accurate MFE/MAE calculations**: Proper foundation for excursion analysis
6. **Maintain complete audit trails**: DECISION→EXECUTION→OUTCOME chains are preserved

## Implementation Notes

### Placeholders for Future Enhancement:
- `liquidityAtDecision` in exit decisions: Currently `null` placeholder - would require integration with real-time liquidity data source
- `volumeAtDecision` and `holderCountAtDecision`: Currently `null` placeholders - would require external data sources
- These are deliberately left as `null` rather than filled with synthetic values to maintain data integrity

### Backward Compatibility:
- All changes are additive - no breaking changes to existing interfaces
- Existing research data format preserved with enhanced NULL handling
- No changes to existing database schemas or storage formats required

## Conclusion

The MAYHEM research pipeline has been successfully audited and corrected to meet the highest standards of data integrity. All synthetic/fabricated values have been eliminated, proper NULL handling implemented, and research data now accurately reflects what was actually measured, what was measured as zero, and what was not measured at all.

These changes ensure that research data can be trusted for analysis, modeling, and strategy development while preserving all existing trading functionality and safety controls.