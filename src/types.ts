export enum SettlementState {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Unresolved = 'unresolved',
  Polling = 'polling',
  ConfirmedLate = 'confirmed_late',
  Failed = 'failed',
  FailedOrphaned = 'failed_orphaned',
}

export interface SettlementProfile {
  name: string;
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
}

export const PROFILES = {
  datacenter: {
    name: 'datacenter',
    facilitatorTimeoutMs: 5_000,
    pollIntervalMs: 2_000,
    maxPollWindowMs: 30_000,
  },
  east_africa: {
    name: 'east_africa',
    facilitatorTimeoutMs: 15_000,
    pollIntervalMs: 5_000,
    maxPollWindowMs: 90_000,
  },
  west_africa: {
    name: 'west_africa',
    facilitatorTimeoutMs: 15_000,
    pollIntervalMs: 5_000,
    maxPollWindowMs: 90_000,
  },
  east_africa_mpesa: {
    name: 'east_africa_mpesa',
    facilitatorTimeoutMs: 20_000,
    pollIntervalMs: 7_000,
    maxPollWindowMs: 120_000,
  },
  west_africa_momo: {
    name: 'west_africa_momo',
    facilitatorTimeoutMs: 20_000,
    pollIntervalMs: 7_000,
    maxPollWindowMs: 120_000,
  },
};

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

export function canonicalKey(ctx: {
  payer: string;
  payTo: string;
  value: string;
  nonce: string;
}): string {
  return `${ctx.payer}:${ctx.payTo}:${ctx.value}:${ctx.nonce}`;
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

export type ProfileName = keyof typeof PROFILES;
