/**
 * @mayhem/lp-intelligence
 *
 * Pure, observational models for pool lifecycle, reserve provenance and LP
 * health.
 *
 * Scope, stated plainly:
 *  - No I/O. No RPC, no HTTP, no database, no clock reads.
 *  - No trading impact. Nothing here is wired to execution, and
 *    `EntryEligibility` is a contract for a later phase, not a live gate.
 *  - No decoding. Chain decoding stays in `RaydiumPoolVerifier` and
 *    `readBondingCurve`; the adapters here only normalize their output.
 *
 * The organising idea is `Observed<T>`: every measurement carries the evidence
 * that produced it, so a reading, an estimate and an absence can never be
 * confused for one another downstream.
 */

export {
  ProvenanceSchema,
  ObservedNumberSchema,
  observedSchema,
  observed,
  estimated,
  unavailable,
  isObservedOnChain,
  hasValue,
  observedValueOrNull,
  mapObserved,
  type Provenance,
  type Observed,
  type ObservedNumber,
  type ObservationEvidence,
} from './provenance.js';

export {
  DexSchema,
  PoolTypeSchema,
  PoolInitializationSchema,
  NormalizedPoolSchema,
  type Dex,
  type PoolType,
  type PoolInitialization,
  type NormalizedPool,
} from './pool.js';

export {
  LifecycleStateSchema,
  LifecycleReasonSchema,
  LifecycleRecordSchema,
  canTransition,
  allowedTransitions,
  isTradeableState,
  isTerminalState,
  type LifecycleState,
  type LifecycleReason,
  type LifecycleRecord,
} from './lifecycle.js';

export {
  LifecycleStateMachine,
  type TransitionInput,
  type TransitionOutcome,
  type TransitionRejection,
} from './state-machine.js';

export {
  LiquidityEventTypeSchema,
  EventSeveritySchema,
  LiquidityEventSchema,
  computeLiquidityChange,
  type LiquidityEventType,
  type EventSeverity,
  type LiquidityEvent,
} from './events.js';

export {
  LpHealthStatusSchema,
  LpHealthReasonSchema,
  LpHealthSchema,
  assessLpHealth,
  type LpHealthStatus,
  type LpHealthReason,
  type LpHealth,
  type LpHealthThresholds,
} from './health.js';

export {
  EligibilityReasonSchema,
  EntryEligibilitySchema,
  explainReason,
  evaluateEntryEligibility,
  type EligibilityReason,
  type EntryEligibility,
} from './eligibility.js';

export {
  InitialReserveSnapshotSchema,
  SnapshotFailureSchema,
  captureInitialReserveSnapshot,
  type InitialReserveSnapshot,
  type SnapshotFailure,
  type SnapshotResult,
} from './snapshot.js';

export {
  type AdapterContext,
  type AdapterResult,
  type PoolAdapter,
} from './adapters/types.js';

export {
  RaydiumPoolAdapter,
  type RaydiumVerifiedPoolLike,
} from './adapters/raydium.js';

export {
  PumpFunPoolAdapter,
  type BondingCurveStateLike,
  type PumpFunObservation,
} from './adapters/pumpfun.js';
