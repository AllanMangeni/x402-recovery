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
  east_africa_3g: {
    name: 'east_africa_3g',
    facilitatorTimeoutMs: 15_000,
    pollIntervalMs: 5_000,
    maxPollWindowMs: 90_000,
  },
  west_africa_3g: {
    name: 'west_africa_3g',
    facilitatorTimeoutMs: 15_000,
    pollIntervalMs: 5_000,
    maxPollWindowMs: 90_000,
  },
};

export type EnvironmentProfile = keyof typeof PROFILES;
