export enum SettlementState {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Failed = 'failed',
  Recovered = 'recovered',
}

export interface SettlementProfile {
  name: string;
  confirmationsRequired: number;
  pollingIntervalMs: number;
  timeoutMs: number;
}

export const PROFILES: Record<string, SettlementProfile> = {
  fast: {
    name: 'fast',
    confirmationsRequired: 1,
    pollingIntervalMs: 2_000,
    timeoutMs: 30_000,
  },
  standard: {
    name: 'standard',
    confirmationsRequired: 3,
    pollingIntervalMs: 5_000,
    timeoutMs: 120_000,
  },
  secure: {
    name: 'secure',
    confirmationsRequired: 6,
    pollingIntervalMs: 10_000,
    timeoutMs: 300_000,
  },
};
