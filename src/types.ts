export enum SettlementState {
  Created = 'created',
  Confirmed = 'confirmed',
  Unresolved = 'unresolved',
  Polling = 'polling',
  ConfirmedLate = 'confirmed_late',
  Failed = 'failed',
  FailedOrphaned = 'failed_orphaned',
}

export const TERMINAL_STATES: ReadonlySet<SettlementState> = new Set([
  SettlementState.Confirmed,
  SettlementState.ConfirmedLate,
  SettlementState.Failed,
  SettlementState.FailedOrphaned,
  SettlementState.Unresolved,
]);

export interface SettlementProfile {
  name: string;
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
  requiredConfirmations?: number;
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
} as const;

export type ProfileName = keyof typeof PROFILES;

export function defineProfile(profile: {
  name: string;
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
  requiredConfirmations?: number;
}): SettlementProfile {
  if (profile.pollIntervalMs >= profile.maxPollWindowMs) {
    throw new Error(
      `defineProfile: pollIntervalMs (${profile.pollIntervalMs}) must be less than maxPollWindowMs (${profile.maxPollWindowMs})`
    );
  }
  if (profile.facilitatorTimeoutMs >= profile.maxPollWindowMs) {
    throw new Error(
      `defineProfile: facilitatorTimeoutMs (${profile.facilitatorTimeoutMs}) must be less than maxPollWindowMs (${profile.maxPollWindowMs})`
    );
  }
  if (profile.facilitatorTimeoutMs <= 0 || profile.pollIntervalMs <= 0 || profile.maxPollWindowMs <= 0) {
    throw new Error('defineProfile: all timing values must be greater than 0');
  }
  if (profile.requiredConfirmations !== undefined && profile.requiredConfirmations <= 0) {
    throw new Error('defineProfile: requiredConfirmations must be greater than 0');
  }
  return profile;
}

export interface SettlementContext {
  settlementId: string;
  simulationId?: string;
  txHash?: string;
  validBefore?: number;
  timedOut: boolean;
  bridgeRef?: string;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
}

export function canonicalKey(input: {
  payer: string;
  payTo: string;
  value: string;
  nonce: string;
}): string {
  return `${input.payer}:${input.payTo}:${input.value}:${input.nonce}`;
}

export function normalizeValidBefore(input: number | bigint | string): number {
  const asNum = typeof input === 'string' ? Number(input) : Number(input);
  if (!Number.isFinite(asNum) || asNum <= 0) {
    throw new Error(`normalizeValidBefore: expected positive number, received ${input}`);
  }
  if (asNum < 1_000_000_000_000) {
    return asNum * 1000;
  }
  return asNum;
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
