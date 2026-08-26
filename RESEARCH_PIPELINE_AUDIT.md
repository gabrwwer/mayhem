# MAYHEM Research Pipeline Audit

## Overview
This document audits the current research data collection pipeline in the MAYHEM Solana trading platform. The audit covers all components responsible for recording research data during DRY_RUN/monitor-only operation.

## Current Record Types

Based on code analysis, the system currently implements these research record types:

1. **DISCOVERY** - Initial token discovery from on-chain events
2. **OBSERVATION** - Momentum evaluation samples and other periodic observations
3. **DECISION** - Buy/Reject decisions made during token evaluation
4. **EXECUTION** - Simulated trade execution attempts (both successful and failed)
5. **OUTCOME** - Defined in ResearchRecorder but currently **NOT USED** in production code
6. **LIFECYCLE** - Complete token lifecycle with performance metrics (recorded via `recordLifecycle`)

## Current Implementation Details

### Research Recorder Core (`packages/trading-engine/src/research-recorder.ts`)

- **File Path**: Defaults to `data/research.jsonl` in process cwd
- **Format**: JSON Lines (JSONL)
- **Schema Version**: 1
- **Deduplication**: Based on event identity (type + mint + event/signature/timestamp/recordId)
- **Validation**: 
  - Requires schemaVersion = 1
  - Valid recordType (DISCOVERY, OBSERVATION, DECISION, EXECUTION, OUTCOME)
  - Valid ISO timestamp
  - Requires mint/tokenMint (except for OUTCOME type)
  - Redacts sensitive fields (secrets, keys, passwords, etc.)
- **Error Handling**: Failures are logged but don't interrupt trading logic

### Record Methods

1. `recordDiscovery()` - Records initial token discovery
2. `recordObservation()` - Records periodic observations (momentum evaluation, etc.)
3. `recordDecision()` - Records BUY/REJECT decisions
4. `recordExecution()` - Records simulated trade execution attempts
5. `recordOutcome()` - **DEFINED BUT NOT CALLED** in production code
6. `recordLifecycle()` - Records complete token lifecycle with performance metrics

### Current Usage in Codebase

#### 1. Discovery Recording (`apps/bot/src/index.ts`)
- Called for every token discovered by token monitor
- Records: `TOKEN_DISCOVERED` event with comprehensive token metadata
- Fields include: mint, tokenMint, source, stage, isPumpFun, creator info, creation time, pool address, quote token, liquidity, decimals, name, symbol, supply info, authorities, metadata URI, transaction signatures, program IDs, pool info, slot info, verification status, vault info, liquidity details

#### 2. Observation Recording (`apps/bot/src/new-launch-handler.ts`)
- Called during momentum evaluation (before decision)
- Records: `MOMENTUM_EVALUATION` event with:
  - Decision confirmation status and reason
  - Price/momentum data (initial/final price, growth per minute, net flow %)
  - Buy/sell pressure metrics
  - Drawdown metrics
  - Market activity (flat ratio, volatility, samples)
  - Sampling quality (failed reads)
  - Timestamp

#### 3. Decision Recording (`apps/bot/src/new-launch-handler.ts`)
- Called in two places:
  - **BUY decision**: When token passes all gates and is approved for entry
  - **REJECT decision**: When token is rejected at any gate (liquidity, risk, momentum, etc.)
- BUY record includes: candidate ID, decision, reason, risk score/level, price, amount, momentum data, pump.fun status, liquidity, depth info, source
- REJECT record includes: candidate ID, decision, reason, rejection reason, stage, plus full context from rejection

#### 4. Execution Recording (`packages/trading-engine/src/engine.ts`)
- Called in `executeEntry()` method:
  - **Failed executions**: Records execution status FAILED with error/status details
  - **Successful executions**: Records execution status CONFIRMED with fill details, slippage, fees
- Fields include: tokenMint, mint, executionStatus, signature, requested/executed amounts, requested/executed prices, slippage (BPS and percent), fees, quoted price, timestamp

#### 5. Lifecycle Recording (`packages/trading-engine/src/engine.ts`)
- Called in `recordPositionLifecycle()` when position exits (via `monitorPositions()`)
- Records complete lifecycle via `researchRecorder.recordLifecycle()`:
  - **Lifecycle stages**: observation time/price, signal time/price, qualification time/price, execution time/price (if available)
  - **Position status**: whether position was opened
  - **Position ID**: if opened
  - **Price history**: collected throughout position lifetime
  - **Performance metrics**: calculated from each lifecycle price across multiple time windows
  - **Slippage**: difference between qualified and execution price
  - **Configuration**: dryRun and tradingEnabled flags

### Event Sources and Collection Points

1. **Token Discovery**:
   - Source: TokenMonitor providers (SolanaTokenProvider, RaydiumLpProvider)
   - Location: `apps/bot/src/index.ts` line 690
   - Trigger: `tokenMonitor.onToken` event
   - Frequency: Every discovered token

2. **Momentum Observation**:
   - Source: NewLaunchHandler momentum evaluation
   - Location: `apps/bot/src/new-launch-handler.ts` line 709
   - Trigger: During `confirmMomentum()`/`confirmEarlyFlow()` evaluation
   - Frequency: Per token during evaluation window

3. **Decision Recording**:
   - Source: NewLaunchHandler decision points
   - Location: `apps/bot/src/new-launch-handler.ts` lines 894 (BUY) and 1497 (REJECT)
   - Trigger: 
     - BUY: After momentum confirmation passes, before entry execution
     - REJECT: At any rejection point (liquidity, risk, momentum, etc.)
   - Frequency: Per token evaluated

4. **Execution Recording**:
   - Source: MayhemEngine executeEntry method
   - Location: `packages/trading-engine/src/engine.ts` lines 385 (failed) and 464 (successful)
   - Trigger: Trade execution attempt
   - Frequency: Per entry attempt

5. **Lifecycle Recording**:
   - Source: MayhemEngine monitorPositions exit handling
   - Location: `packages/trading-engine/src/engine.ts` line 1105
   - Trigger: Position exit (stop loss, take profit, etc.)
   - Frequency: Per closed position

## Current Field Coverage

### Discovery Record Fields
- recordId, schemaVersion, recordedAt, recordType, event
- Identification: mint, tokenMint
- Source tracking: source, observedViaWebsocket
- Token metadata: name, symbol, decimals, supply, supplyRaw
- Creation info: createdAt, creator, creatorSource
- Mint authorities: mintAuthority, freezeAuthority
- Metadata: metadataUri, txSignature
- Dex info: dexProgramId, poolType
- Pool info: poolAddress, poolVerifiedAtMs, poolVerificationStatus, poolVerificationReason
- Vault info: baseVault, quoteVault
- Reserves: quoteReserveSol, totalLiquiditySol
- LP info: lpMint, lpPositionAddress, lpLockOrBurnVerified
- Initial liquidity: initialLiquidity
- Launch detection: detectedSlot, initializationSlot

### Observation Record Fields (MOMENTUM_EVALUATION)
- recordId, schemaVersion, recordedAt, recordType, event
- Identification: mint, tokenMint
- Decision: confirmed, reason
- Price/momentum: initialPrice, finalPrice, growthPerMin, netFlowPct
- Buy/sell pressure: buyPressure, flowBuyPressure
- Drawdown: maxDrawdownPct, finalDrawdownPct
- Market activity: flatRatio, flatIntervals, volatility
- Sampling: samples, failedReads
- Timestamp: observedAt

### Decision Record Fields (BUY/REJECT)
- recordId, schemaVersion, recordedAt, recordType
- Identification: tokenMint, mint, candidateId, recordId
- Decision: decision (BUY/REJECT)
- Reason: reason (and rejectionReason for REJECT)
- Stage: stage (for REJECT)
- Risk data: riskScore, riskLevel
- Trade params: price, amount
- Momentum data: confirmed, finalPrice, growthPerMin, buyPressure, flowBuyPressure, maxDrawdownPct, finalDrawdownPct, volatility
- Token type: isPumpFun
- Liquidity: liquidity, depthSol, depthMeasured
- Source: event.source
- Timestamp: recordedAt

### Execution Record Fields
- recordId, schemaVersion, recordedAt, recordType
- Identification: tokenMint, mint
- Execution: executionStatus, signature
- Amounts: requestedAmount, executedAmount
- Prices: requestedPrice, executedPrice
- Slippage: slippageBps, slippagePercent
- Fees: fees
- Quote: quotedPrice (for successful executions)
- Timestamp: timestamp
- Failure info: reason (for failed executions)

### Lifecycle Record Fields
- recordId, schemaVersion, recordedAt, recordType (implicitly LIFECYCLE via recordLifecycle)
- Core: tokenMint, positionOpened, positionId, priceHistory
- Lifecycle: observationTime, observationPrice, signalTime, signalPrice, qualificationTime, qualifiedEntryPrice, executionTime, executionPrice
- Performance: performanceFromObservationPrice, performanceFromSignalPrice, performanceFromQualifiedEntryPrice, performanceFromExecutionPrice
- Slippage: slippageBps, slippagePercent
- Config: dryRun, tradingEnabled

## Missing Events and Gaps

Based on the MAYHEM research requirements document, the following gaps exist:

### Missing Event Types
1. **LP_INITIALIZATION** - Not explicitly recorded as a separate event type
2. **LIQUIDITY_EVENT** - Not explicitly recorded as a separate event type  
3. **MOMENTUM_EVENT** - Not explicitly recorded (though momentum data is in OBSERVATION and LIFECYCLE)
4. **GRADUATION** - Graduation detection exists but not recorded as research event
5. **METADATA_UPDATE** - Metadata changes over time not tracked
6. **STALE_EVENT** - Staleness detection exists but not recorded as research event

### Missing Metrics and Fields

#### From Discovery
- Missing: launchPlatform, venue, programId (only partially covered)
- Missing: developerWallet, creatorWallet distinction
- Missing: migrationAddress, migrationSignature, graduationStatus
- Missing: bondingCurveAddress, bondingCurveProgram (for pump.fun)

#### From Observation/Ongoing Tracking
- Missing: Continuous LP initialization tracking
- Missing: Liquidity change events and rates
- Missing: Volume taxonomy (buy/sell volume, volume multipliers, surges/collapses)
- Missing: Buy/sell pressure over time windows
- Missing: Trade flow metrics (unique traders, large trades, trade size distribution)
- Missing: Volatility measures (realized volatility, ATR-like, range measures)
- Missing: Momentum taxonomy (multi-state momentum scoring)
- Missing: Trend structure (VWAP, higher/lower highs/lows)
- Missing: Pullback/support/continuation detection
- Missing: Holder/wallet taxonomy (holder count, concentration, wallet behavior)
- Missing: Token metadata tracking over time
- Missing: Launch platform specifics
- Missing: Graduation/migration event tracking
- Missing: Execution simulation details (entry signal, slippage, fees, priority fees)
- Missing: Position simulation (MFE/MAE curves, profit threshold timing)
- Missing: Take-profit research data
- Missing: Stop-loss/trailing stop research data
- Missing: Liquidity/execution risk ratios
- Missing: Token staleness tracking

#### From Decision
- Missing: Comprehensive scoring breakdown (momentumScore, volumeScore, liquidityScore, etc.)
- Missing: Overall score calculation
- Missing: Risk score components

#### From Execution
- Missing: Detailed execution simulation (impact, fees, priority fees, Jito tips)
- Missing: Execution quality classification

#### From Lifecycle/Outcome
- Missing: Position simulation thresholds (+1%, +2%, etc. tracking)
- Missing: Take-profit ladder research
- Missing: Stop-loss/trailing stop research
- Missing: Maximum favorable/adverse excursion tracking over time
- Missing: Exit reason classification (TP, TRAIL, STOP_LOSS, etc.)
- Missing: Post-graduation tracking
- Missing: Stale/dead state detection and recording

### Missing Correlation Identifiers
While the system uses:
- tokenMint as primary identifier
- recordId for individual records
- positionId for open positions
- candidateId for tokens in evaluation

It lacks:
- Explicit eventId for linking related events
- Clear lifecycle chain visibility (though lifecytime tracking connects observation→signal→qualification→execution)

### Missing Timestamps
The system records:
- observationTime, signalTime, qualificationTime, executionTime
- recordedAt for when record was created
- createdAt from token discovery
- Various timeout timestamps

Missing:
- lpInitializedAt
- graduationAt
- lastSeenAt, lastTradeAt, etc. for staleness detection

### Missing Deduplication Considerations
The current deduplication is based on event identity but may not properly handle:
- Multiple observations of same token at different times (these should NOT be deduplicated)
- The system correctly avoids deduplicating based solely on mint+timestamp by including event type/signature

## Schema Versions
- Current schemaVersion: 1 (hardcoded in research-recorder.ts)
- No explicit schema migration mechanism
- Schema evolution would require manual handling

## File Paths and Configuration
- Primary research file: `apps/bot/data/research.jsonl` (1.0MB observed)
- Secondary/research file: `/mnt/c/dev/mayhem/mq/research.jsonl` (9.4KB, appears to be test/dev data)
- Configuration: Controlled by `.env` file with research settings:
  - RESEARCH_MODE_ENABLED=true
  - Individual flags for what to record (discovery, samples, rejections, entries, etc.)
  - Observation window and sampling parameters
  - Data collection scopes (holders, curve state, pool state, transaction flow, etc.)
  - Data quality settings (RPC failure recording, data status tracking)
  - Caching (metadata cache)

## Current Lifecycle Coverage
The system currently captures:
1. **Discovery** (when token first seen on-chain)
2. **Observation** (during momentum evaluation window)
3. **Decision** (BUY/REJECT decision point)
4. **Execution** (simulated trade attempt)
5. **Lifecycle** (complete timeline from discovery to exit with performance metrics)

However, the lifecycle recording only happens when a position is actually opened and subsequently closed. Tokens that are rejected never get a full lifecycle record.

## Failure Modes Identified

1. **Research Recorder Failure**: If the research recorder fails initialization (file path issues, permissions), it sets `failed = true` and stops recording but logs the failure. Trading continues uninterrupted.

2. **Write Failures**: If appending to the JSONL file fails, the recorder marks itself as failed and stops recording. Trading continues.

3. **Validation Failures**: If a record fails validation (missing required fields, invalid schemaVersion, etc.), it's logged and skipped. Trading continues.

4. **Memory Leak Potential**: The `seenRecordKeys` set grows indefinitely with unique record identities. In a long-running process, this could consume significant memory.

5. **JSONL File Growth**: The research.jsonl file grows indefinitely with no rotation or archiving mechanism.

6. **Missing Outcome Recording**: Despite having a recordOutcome method, it is never called, soOUTCOME records are never produced.

7. **Incomplete Lifecycle for Rejected Tokens**: Rejected tokens only get DISCOVERY and possibly OBSERVATION and DECISION records, but never get a full LIFECYCLE record since they never reach position opening/execution.

## Test Coverage
From the code search, there are tests for:
- Research recorder basic functions
- Research integration tests
- Engine integration tests (including lifecycle recording)
- Research audit tests
- Unit tests mocking research recorder calls

## Summary
The research pipeline is functional and captures substantial data, particularly around:
- Initial token discovery with rich metadata
- Momentum evaluation observations
- Entry/execution decisions
- Simulated execution attempts
- Complete lifecycle performance for entered positions

However, significant gaps exist in capturing the comprehensive token lifecycle taxonomy and research dimensions specified in the requirements, particularly:
- Continuous tracking of liquidity, volume, flow, holders
- Graduation/migration events
- Staleness detection
- Detailed execution simulation
- Position simulation and threshold tracking
- Advanced momentum, volatility, and trend analysis
- Explicit OUTCOME record production