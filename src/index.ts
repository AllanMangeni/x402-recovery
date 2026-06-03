export { createSettlementStateMachine } from './state-machine';
export type { StateMachine, SettlementRecord, CreateSettlementOptions, SettlementRecordUpdate } from './state-machine';
export {
  SettlementState,
  TERMINAL_STATES,
  PROFILES,
  canonicalKey,
  batchCanonicalKey,
  defineProfile,
  normalizeValidBefore,
  type SettlementProfile,
  type ProfileName,
  type SettlementContext,
  type TransitionEvent,
  type StateMachineOptions,
  type ReceiptProvider,
  type SettlementReceipt,
  type AfterSettleTimeoutPayload,
  type AfterSettleTimeoutHook,
} from './types';
export { pollUntilResolved, type PollUntilResolvedParams } from './poller';
export { createViemReceiptProvider } from './adapters/viem';
export * from './adapters';
export { createRecoveryHook, RecoveryPlugin } from './hooks';
export type { SettlementFailureContext, RecoveryHookConfig } from './hooks';
export { RecoveryError, isRecoveryError } from './errors';
export type { RecoveryErrorDetails } from './errors';
