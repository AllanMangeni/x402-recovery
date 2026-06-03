import { RecoveryError } from './errors';

export enum SettlementState {
  Created = 'created',
  Confirmed = 'confirmed',
  Unresolved = 'unresolved',
  Polling = 'polling',
  ConfirmedLate = 'confirmed_late',
  Failed = 'failed',
  FailedOrphaned = 'failed_orphaned',
  ClaimPending = 'claim_pending',
  ClaimConfirmed = 'claim_confirmed',
  SettlePending = 'settle_pending',
  SettleConfirmed = 'settle_confirmed',
}

export const TERMINAL_STATES: ReadonlySet<SettlementState> = new Set([
  SettlementState.Confirmed,
  SettlementState.ConfirmedLate,
  SettlementState.Failed,
  SettlementState.FailedOrphaned,
  SettlementState.Unresolved,
  SettlementState.SettleConfirmed,
]);

export interface SettlementProfile {
  name: string;
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
  requiredConfirmations?: number;
  indexerLagMs?: number;
}

export const PROFILES = {
  datacenter: defineProfile({
    name: 'datacenter',
    facilitatorTimeoutMs: 5_000,
    pollIntervalMs: 2_000,
    maxPollWindowMs: 30_000,
    requiredConfirmations: 1,
  }),

  emerging_markets: defineProfile({
    name: 'emerging_markets',
    facilitatorTimeoutMs: 15_000,
    pollIntervalMs: 5_000,
    maxPollWindowMs: 90_000,
    requiredConfirmations: 1,
  }),

  batch: defineProfile({
    name: 'batch',
    facilitatorTimeoutMs: 30_000,
    pollIntervalMs: 8_000,
    maxPollWindowMs: 48_000,
    requiredConfirmations: 1,
    indexerLagMs: 10_000,
  }),
} as const;

export type ProfileName = keyof typeof PROFILES;

export function defineProfile(profile: {
  name: string;
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
  requiredConfirmations?: number;
  indexerLagMs?: number;
}): SettlementProfile {
  if (profile.pollIntervalMs >= profile.maxPollWindowMs) {
    throw new RecoveryError(
      'profile_invalid', 400,
      `pollIntervalMs (${profile.pollIntervalMs}) must be less than maxPollWindowMs (${profile.maxPollWindowMs})`,
      { pollIntervalMs: profile.pollIntervalMs, maxPollWindowMs: profile.maxPollWindowMs },
    );
  }
  if (profile.facilitatorTimeoutMs >= profile.maxPollWindowMs) {
    throw new RecoveryError(
      'profile_invalid', 400,
      `facilitatorTimeoutMs (${profile.facilitatorTimeoutMs}) must be less than maxPollWindowMs (${profile.maxPollWindowMs})`,
      { facilitatorTimeoutMs: profile.facilitatorTimeoutMs, maxPollWindowMs: profile.maxPollWindowMs },
    );
  }
  if (profile.facilitatorTimeoutMs <= 0 || profile.pollIntervalMs <= 0 || profile.maxPollWindowMs <= 0) {
    throw new RecoveryError('profile_invalid', 400, 'All timing values must be greater than 0', { timingValues: { facilitatorTimeoutMs: profile.facilitatorTimeoutMs, pollIntervalMs: profile.pollIntervalMs, maxPollWindowMs: profile.maxPollWindowMs } });
  }
  if (profile.requiredConfirmations !== undefined && (!Number.isInteger(profile.requiredConfirmations) || profile.requiredConfirmations <= 0)) {
    throw new RecoveryError('profile_invalid', 400, 'requiredConfirmations must be greater than 0', { requiredConfirmations: profile.requiredConfirmations });
  }
  return profile;
}

export interface SettlementContext {
  settlementId: string;
  simulationId?: string;
  txHash?: string;
  claimTxHash?: string;
  settleTxHash?: string;
  validBefore?: number;
  timedOut?: boolean;
  bridgeRef?: string;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
  scheme?: 'exact' | 'batch';
  network?: string;
  facilitatorResponse?: unknown;
}

export function canonicalKey(input: {
  payer: string;
  payTo: string;
  value: string;
  nonce: string;
}): string {
  return `${input.payer.toLowerCase()}:${input.payTo.toLowerCase()}:${input.value}:${input.nonce}`;
}

export function normalizeValidBefore(input: number | bigint | string): number {
  const asNum = typeof input === 'string' ? Number(input) : Number(input);
  if (!Number.isFinite(asNum) || asNum <= 0) {
    throw new RecoveryError('valid_before_invalid', 400, `Expected positive number, received ${String(input)}`, { input: String(input) });
  }
  // Heuristic: if value is under year 33658 in seconds (~1e12 ms), treat as
  // seconds and convert to milliseconds. Values above this threshold are
  // assumed to already be in milliseconds.
  //   seconds range (2020s):   ~1.7e9  → converted
  //   milliseconds range:       ~1.7e12 → left as-is
  if (asNum < 1_000_000_000_000) {
    return asNum * 1000;
  }
  return asNum;
}

export function batchCanonicalKey(payer: string, payTo: string, nonce: string, claimTxHash: string): string {
  return `${payer.toLowerCase()}:${payTo.toLowerCase()}:${nonce}:${claimTxHash.toLowerCase()}`;
}

export interface TransitionEvent {
  settlementId: string;
  from: SettlementState;
  to: SettlementState;
  timestamp: number;
  txHash?: string;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
}

export interface StateMachineOptions {
  onTransition?: (event: TransitionEvent) => void;
}

export interface ReceiptProvider {
  getTransactionReceipt(input: {
    txHash: `0x${string}`;
  }): Promise<SettlementReceipt | null>;
}

export interface SettlementReceipt {
  status: 'success' | 'reverted' | 'unknown';
  blockNumber?: bigint;
  confirmations?: number;
}

export interface AfterSettleTimeoutPayload {
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
  txHash?: string;
  validBefore?: number;
  network?: string;
  facilitatorResponse?: unknown;
  scheme: 'exact' | 'batch';
}

export type AfterSettleTimeoutHook = (payload: AfterSettleTimeoutPayload) => void | Promise<void>;
