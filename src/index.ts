export { createSettlementStateMachine } from './state-machine';
export type { StateMachine, SettlementRecord, CreateSettlementOptions } from './state-machine';
export {
  SettlementState,
  TERMINAL_STATES,
  PROFILES,
  canonicalKey,
  defineProfile,
  normalizeValidBefore,
  type SettlementProfile,
  type ProfileName,
  type SettlementContext,
  type TransitionEvent,
  type StateMachineOptions,
  type ReceiptProvider,
  type SettlementReceipt,
} from './types';
export { createRecoveryMiddleware } from './middleware';
export type { RecoveryConfig, PollDispatcher } from './middleware';
export { pollUntilResolved, type PollUntilResolvedParams } from './poller';
export { createViemReceiptProvider } from './adapters/viem';
export * from './adapters';
