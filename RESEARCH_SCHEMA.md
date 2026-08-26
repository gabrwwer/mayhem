# MAYHEM Research Schema Documentation

## Schema Version 2.0 - Enhanced Research Record

This document describes the EnhancedResearchRecord schema version 2.0, which provides comprehensive tokenomics research data capture for the MAYHEM trading platform.

## Overview

The EnhancedResearchRecord schema extends the original ResearchRecord (v1.0) to support the full 35-phase tokenomics research taxonomy while maintaining backward compatibility.

## Schema Structure

### Core Identification Fields
```typescript
{
  // Unique identifier for this research record
  recordId: string;
  
  // Schema version (1 for legacy, 2 for enhanced)
  schemaVersion: 1 | 2;
  
  // Timestamp when record was created (ISO 8601)
  recordedAt: string;
  
  // Type of research record (see Event Types below)
  recordType: 
    | 'DISCOVERY'
    | 'OBSERVATION'
    | 'DECISION'
    | 'EXECUTION'
    | 'OUTCOME'
    | 'LP_INITIALIZATION'
    | 'LIQUIDITY_EVENT'
    | 'MOMENTUM_EVENT'
    | 'GRADUATION'
    | 'METADATA_UPDATE'
    | 'STALE_EVENT'
    | 'POSITION_SIMULATION'
    | 'TAKE_PROFIT_RESEARCH'
    | 'STOP_LOSS_RESEARCH'
    | 'LIQUIDITY_EXECUTION_RISK';
    
  // Optional event subtype for more granular categorization
  event?: string;
  
  // Token identifier (required for most event types)
  tokenMint?: string;
  mint?: string; // Alternative field name for backward compatibility
}
```

### Event Types

#### 1. DISCOVERY - Initial Token Discovery
Recorded when a token is first discovered on-chain. Contains comprehensive token identity and initial state data.

#### 2. OBSERVATION - Continuous Monitoring Data
Periodic snapshots of token state during evaluation windows. Contains rich observation data.

#### 3. DECISION - Evaluation Decision Points
Records BUY/REJECT/QUALIFIED decisions with comprehensive scoring breakdown.

#### 4. EXECUTION - Simulated Trade Execution
Records simulated execution attempts (DRY_RUN mode) or actual executions.

#### 5. OUTCOME - Position Completion Results
Records the final outcome of completed positions (simulated or actual).

#### 6. LP_INITIALIZATION - Liquidity Pool Initialization
Records when liquidity is initialized for a token (especially relevant for pump.fun bonding curves).

#### 7. LIQUIDITY_EVENT - Liquidity Change Events
Records significant changes in liquidity levels over time.

#### 8. MOMENTUM_EVENT - Momentum State Changes
Records transitions between momentum taxonomy states.

#### 9. GRADUATION - Migration/Graduation Events
Records when a token graduates from its launch platform (e.g., pump.fun to Raydium).

#### 10. METADATA_UPDATE - Token Metadata Changes
Records changes to token metadata (name, symbol, social links, etc.).

#### 11. STALE_EVENT - Staleness Detection
Records when a token is detected as stale/dead based on inactivity thresholds.

#### 12. POSITION_SIMULATION - Hypothetical Position Analysis
Records data from simulated position analysis (what-if scenarios).

#### 13. TAKE_PROFIT_RESEARCH - Take-Profit Strategy Research
Records data for evaluating take-profit ladder effectiveness.

#### 14. STOP_LOSS_RESEARCH - Stop-Loss Strategy Research
Records data for evaluating stop-loss and trailing stop strategies.

#### 15. LIQUIDITY_EXECUTION_RISK - Execution Risk Analysis
Records analysis of liquidity/execution quality and risk factors.

### Enhanced Data Objects

The following nested objects provide specialized data for different aspects of tokenomics research:

#### VolumeData
```typescript
interface VolumeData {
  // Buy/sell volume over different time windows
  buyVolume5m: number;
  sellVolume5m: number;
  buyVolume1h: number;
  sellVolume1h: number;
  buyVolume6h: number;
  sellVolume6h: number;
  
  // Volume multipliers and surges
  volumeMultiplier5m: number;
  volumeMultiplier1h: number;
  volumeSurgeDetected: boolean;
  volumeCollapseDetected: boolean;
  
  // Volume-weighted metrics
  vwap5m: number;
  vwap1h: number;
  vwap6h: number;
}
```

#### PressureData
```typescript
interface PressureData {
  // Buy/sell pressure metrics
  buyPressure: number; // 0-1 scale
  sellPressure: number; // 0-1 scale
  netPressure: number; // -1 to 1 scale
  
  // Pressure over time
  buyPressure5m: number;
  sellPressure5m: number;
  buyPressure1h: number;
  sellPressure1h: number;
  
  // Flow metrics
  netFlowPct: number; // Net flow percentage
  flowBuyPressure: number; // Buying flow pressure
  flowSellPressure: number; // Selling flow pressure
}
```

#### MomentumData
```typescript
interface MomentumData {
  // Momentum taxonomy state (9-state model)
  momentumState: 
    | 'NO_MOMENTUM'
    | 'EARLY_MOMENTUM'
    | 'ACCELERATING'
    | 'STRONG'
    | 'CONFIRMED'
    | 'EXTREME'
    | 'EXHAUSTING'
    | 'REVERSING'
    | 'FAILED';
    
  // Momentum scores and metrics
  momentumScore: number; // 0-100 composite score
  growthPerMin: number; // Price growth percentage per minute
  momentumAcceleration: number; // Rate of change of momentum
  
  // Price-based momentum
  priceChange1m: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange1h: number;
  priceChange6h: number;
  
  // Volume-confirmed momentum
  volumeConfirmed: boolean;
  volumeMomentumAlignment: number; // -1 to 1 scale
}
```

#### TrendData
```typescript
interface TrendData {
  // VWAP analysis
  vwap: number;
  vwapDeviation: number; // Percentage deviation from VWAP
  vwapTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  
  // Trend detection by timeframe
  trend5m: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  trend1h: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  trend6h: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  
  // Swing point detection
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  
  // Trend strength metrics
  trendStrength: number; // 0-100
  trendConsistency: number; // 0-100
}
```

#### HolderWalletData
```typescript
interface HolderWalletData {
  // Holder concentration metrics
  holderCount: number;
  top10HolderPercentage: number; // % held by top 10 holders
  top20HolderPercentage: number; // % held by top 20 holders
  top50HolderPercentage: number; // % held by top 50 holders
  
  // Holder distribution
  whaleCount: number; // Holders >1% of supply
  dolphinCount: number; // Holders 0.1%-1% of supply
  fishCount: number; // Holders 0.01%-0.1% of supply
  shrimpCount: number; // Holders <0.01% of supply
  
  // Wallet behavior metrics
  walletTurnover24h: number; // Percentage of wallets that traded in 24h
  newWallets24h: number; // New wallets created in 24h
  dormantWallets: number; // Wallets with no activity in 7d
  
  // Smart money indicators
  smartMoneyInflow: number; // Net inflow from identified smart wallets
  smartMoneyTokenAge: number; // Average token age of smart money wallets
}
```

#### TokenMetadata
```typescript
interface TokenMetadata {
  // Basic token info
  name: string;
  symbol: string;
  decimals: number;
  
  // Supply information
  supply: number;
  supplyRaw: string; // Raw string representation for precision
  
  // Metadata URI and content
  metadataUri: string;
  metadataFetched: boolean;
  metadataJson?: {
    name: string;
    symbol: string;
    description: string;
    image: string;
    attributes: Array<{trait_type: string; value: string | number}>;
  };
  
  // Social and community links
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  
  // Creation and update timestamps
  createdAt: string;
  updatedAt: string;
}
```

#### LaunchPlatformData
```typescript
interface LaunchPlatformData {
  // Platform identification
  platform: 'PUMP_FUN' | 'RAYDIUM' | 'OPENSEA' | 'MAGIC_EDEN' | 'OTHER';
  platformProgramId: string;
  
  // Platform-specific metrics
  bondingCurveAddress: string; // For pump.fun
  bondingCurveProgram: string;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  
  // Launch details
  launchSlot: number;
  launchTime: string;
  initialLiquidityProvided: boolean;
  initialLiquidityAmount: number;
  
  // Migration tracking
  migrationAddress: string;
  migrationSignature: string;
  migrationCompleted: boolean;
  migrationTime: string;
  
  // Graduation status
  graduationStatus: 'NOT_GRADUATED' | 'GRADUATING' | 'GRADUATED' | 'FAILED';
  graduationThreshold: number; // Market cap at which graduation occurs
}
```

#### GraduationData
```typescript
interface GraduationData {
  // Graduation event details
  graduationType: 'PLATFORM_MIGRATION' | 'LIQUIDITY_BOOST' | 'TOKEN_UPGRADE';
  fromPlatform: string;
  toPlatform: string;
  
  // Pre/post graduation metrics
  preGraduationLiquidity: number;
  postGraduationLiquidity: number;
  preGraduationVolume24h: number;
  postGraduationVolume24h: number;
  preGraduationHolderCount: number;
  postGraduationHolderCount: number;
  
  // Graduation timing and success
  graduationTime: string;
  graduationBlock: number;
  graduationSignature: string;
  graduationSuccess: boolean;
  graduationSlippageBps: number;
}
```

#### ExecutionSimulation
```typescript
interface ExecutionSimulation {
  // Simulated entry parameters
  requestedAmount: number;
  requestedPrice: number;
  requestedSolAmount: number;
  
  // Simulated execution results
  executedAmount: number;
  executedPrice: number;
  executedSolAmount: number;
  
  // Execution quality metrics
  slippageBps: number;
  slippagePercent: number;
  feesPaid: number;
  priorityFeePaid: number;
  jitoTipPaid: number;
  
  // Market impact estimation
  marketImpactBps: number;
  liquidityConsumedPct: number;
  
  // Execution timing
  simulationTime: string;
  blockTimestamp: number;
  
  // Execution status
  executionStatus: 'CONFIRMED' | 'FAILED' | 'REJECTED';
  failureReason?: string;
}
```

#### PositionSimulation
```typescript
interface PositionSimulation {
  // Position parameters
  entryPrice: number;
  positionSizeSol: number;
  positionSizeTokens: number;
  
  // Profit/loss tracking
  unrealizedPnlPercent: number;
  unrealizedPnlSol: number;
  
  // Maximum favorable/adverse excursion
  mfePercent: number; // Maximum Favorable Excursion
  maePercent: number; // Maximum Adverse Excursion
  mfeTimestamp: number;
  maeTimestamp: number;
  
  // Profit threshold timing
  timeToPlus1Percent: number; // Seconds to reach +1%
  timeToPlus2Percent: number; // Seconds to reach +2%
  timeToPlus5Percent: number; // Seconds to reach +5%
  timeToPlus10Percent: number; // Seconds to reach +10%
  timeToPlus25Percent: number; // Seconds to reach +25%
  timeToPlus50Percent: number; // Seconds to reach +50%
  timeToPlus100Percent: number; // Seconds to reach +100%
  
  // Loss threshold timing
  timeToMinus5Percent: number; // Seconds to reach -5%
  timeToMinus10Percent: number; // Seconds to reach -10%
  timeToMinus20Percent: number; // Seconds to reach -20%
  
  // Position duration
  positionDurationSec: number;
  
  // Exit simulation
  exitPrice: number;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'MANUAL' | 'LIQUIDATION';
  exitTime: string;
}
```

#### TakeProfitResearch
```typescript
interface TakeProfitResearch {
  // Take-profit ladder configuration
  tpLevels: Array<{
    price: number;
    percent: number;
    allocatedPercentage: number; // % of position allocated to this TP level
  }>;
  
  // TP level performance
  tpLevelResults: Array<{
    level: number;
    hit: boolean;
    hitTime: number;
    slippageBps: number;
    executionPrice: number;
    profitPercent: number;
  }>;
  
  // Overall TP research metrics
  tpStrategy: 'FIXED_LADDER' | 'VOLATILITY_ADJUSTED' | 'MOMENTUM_BASED';
  tpSuccessRate: number; // Percentage of TP levels hit
  avgTimeToTP: number; // Average time to hit TP levels
  tpProfitFactor: number; // Gross profit / gross loss from TP levels
}
```

#### StopLossResearch
```typescript
interface StopLossResearch {
  // Stop-loss configuration
  stopLossType: 'FIXED_PERCENT' | 'VOLATILITY_ADJUSTED' | 'TRAILING' | 'SUPPORT_BASED';
  stopLossPrice: number;
  stopLossPercent: number;
  
  // Trailing stop parameters (if applicable)
  trailingDistance: number; // Percent trailing distance
  trailingActivation: number; // Percent profit to activate trailing
  
  // SL level performance
  slHit: boolean;
  slHitTime: number;
  slippageBps: number;
  executionPrice: number;
  lossPercent: number;
  
  // SL research metrics
  slStrategyEffectiveness: number; // 0-100 score
  falsePositiveRate: number; // Percentage of SL hits that reversed
  avgTimeToSL: number; // Average time to hit SL
}
```

#### LiquidityExecutionRisk
```typescript
interface LiquidityExecutionRisk {
  // Liquidity metrics
  liquiditySol: number;
  liquidityTokens: number;
  liquidityUsd: number;
  
  // Position-to-liquidity ratios
  positionToLiquidityRatio: number; // Position size as % of liquidity
  maxRecommendedPositionPct: number; // Maximum recommended position size % of liquidity
  
  // Execution risk estimates
  estimatedSlippageBps: number;
  estimatedMarketImpactBps: number;
  estimatedFeesSol: number;
  
  // Risk classifications
  liquidityRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  executionRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  
  // Order book metrics (if available)
  bidAskSpreadBps: number;
  orderBookDepth: number;
  
  // Priority fee recommendations
  recommendedPriorityFeeMicrolamports: number;
}
```

### Backward Compatibility

Schema version 2.0 maintains backward compatibility with version 1.0 through:

1. **Optional Fields**: All enhanced fields are optional, allowing version 1.0 consumers to ignore them
2. **Schema Version Field**: Explicit `schemaVersion` field allows consumers to identify the schema version
3. **Field Name Consistency**: Core fields like `tokenMint`, `recordedAt`, `recordId` remain unchanged
4. **Event Type Extension**: New event types are additions, not replacements of existing types

### Data Quality and Validation

1. **JSON Lines Format**: Each record is a valid JSON object on its own line
2. **Atomic Writes**: Records are appended atomically to prevent corruption
3. **Field Validation**: Required fields are validated before recording
4. **Redaction**: Sensitive fields (API keys, secrets, etc.) are automatically redacted
5. **Deduplication**: Intelligent deduplication prevents excessive storage while preserving distinct events
6. **Fail-Safe Design**: Recording errors are logged but never interrupt trading logic

### Storage and Performance Considerations

1. **Append-Only**: JSONL format enables efficient appending without rewriting entire file
2. **Streaming Processing**: Records can be processed in streaming fashion for analysis
3. **Compression Friendly**: JSONL compresses well with standard tools (gzip, etc.)
4. **Partitioning**: Records can be partitioned by date or token for large-scale analysis
5. **Indexing**: Secondary indexes can be built on common query fields (tokenMint, recordType, recordedAt)

### Example Records

#### Discovery Record (Schema v2.0)
```json
{
  "recordId": "550e8400-e29b-41d4-a716-446655440000",
  "schemaVersion": 2,
  "recordedAt": "2026-08-19T10:30:00.000Z",
  "recordType": "DISCOVERY",
  "event": "TOKEN_DISCOVERED",
  "tokenMint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "mint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "name": "Test Token",
  "symbol": "TEST",
  "decimals": 6,
  "supply": 1000000000,
  "supplyRaw": "1000000000",
  "createdAt": "2026-08-19T10:25:00.000Z",
  "creator": "CreatorWalletAddress123...",
  "initialLiquidity": 10.5,
  "totalLiquiditySol": 10.5,
  "isPumpFun": true,
  "metadataUri": "https://arweave.net/test-metadata",
  "dexProgramId": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "poolAddress": "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2",
  "source": "solana-token-provider"
}
```

#### Observation Record (Schema v2.0)
```json
{
  "recordId": "660e8400-e29b-41d4-a716-446655440000",
  "schemaVersion": 2,
  "recordedAt": "2026-08-19T10:35:00.000Z",
  "recordType": "OBSERVATION",
  "event": "CONTINUOUS_OBSERVATION",
  "tokenMint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "observedAt": "2026-08-19T10:35:00.000Z",
  "volumeData": {
    "buyVolume5m": 5.2,
    "sellVolume5m": 3.1,
    "buyVolume1h": 25.6,
    "sellVolume1h": 18.9,
    "volumeMultiplier5m": 2.3,
    "volumeMultiplier1h": 1.8,
    "vwap5m": 0.00105,
    "vwap1h": 0.00102
  },
  "pressureData": {
    "buyPressure": 0.65,
    "sellPressure": 0.35,
    "netPressure": 0.3,
    "buyPressure5m": 0.7,
    "sellPressure5m": 0.3,
    "netFlowPct": 15.2
  },
  "momentumData": {
    "momentumState": "CONFIRMED",
    "momentumScore": 78.5,
    "growthPerMin": 12.5,
    "priceChange5m": 45.2,
    "priceChange1h": 120.8,
    "volumeConfirmed": true
  },
  "trendData": {
    "vwap": 0.00103,
    "vwapDeviation": 1.2,
    "vwapTrend": "BULLISH",
    "trend5m": "UPTREND",
    "trend1h": "UPTREND",
    "higherHigh": true,
    "higherLow": true
  },
  "holderWalletData": {
    "holderCount": 142,
    "top10HolderPercentage": 35.2,
    "whaleCount": 8,
    "dolphinCount": 25,
    "fishCount": 60,
    "shrimpCount": 49
  }
}
```

### Implementation Notes

1. **Schema Evolution**: Future schema versions will follow semantic versioning (MAJOR.MINOR.PATCH)
2. **Backward Compatibility**: Minor and patch versions will maintain backward compatibility
3. **Major Version Changes**: May introduce breaking changes with migration guides
4. **Field Deprecation**: Deprecated fields will be marked with comments and removed in future major versions
5. **Extension Mechanism**: New research dimensions can be added as new optional objects without breaking existing consumers

### Related Documents

- [RESEARCH_DATA_DICTIONARY.md](./RESEARCH_DATA_DICTIONARY.md): Detailed field descriptions and data types
- [RESEARCH_PIPELINE_AUDIT.md](./RESEARCH_PIPELINE_AUDIT.md): Audit of current research pipeline capabilities and gaps
- [DRY_RUN_VALIDATION_REPORT.md](./DRY_RUN_VALIDATION_REPORT.md): Validation of DRY_RUN execution simulation accuracy

_Last Updated: 2026-08-19_