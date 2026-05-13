import { SettlementState, SettlementProfile, PROFILES, EnvironmentProfile } from './types';

export interface SettlementRecord {
  id: string;
  state: SettlementState;
  profile: SettlementProfile;
  txHash?: string;
  validBefore?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StateMachine {
  create(
    id: string,
    options?: { profileName?: EnvironmentProfile; txHash?: string; validBefore?: number },
  ): SettlementRecord;
  get(id: string): SettlementRecord | undefined;
  transition(id: string, newState: SettlementState): SettlementRecord;
  list(): SettlementRecord[];
}

export function createSettlementStateMachine(): StateMachine {
  const records = new Map<string, SettlementRecord>();

  function resolveProfile(profileName: EnvironmentProfile): SettlementProfile {
    const profile = PROFILES[profileName];
    if (!profile) {
      throw new Error(`Unknown settlement profile: ${profileName}`);
    }
    return profile;
  }

  return {
    create(
      id: string,
      options?: { profileName?: EnvironmentProfile; txHash?: string; validBefore?: number },
    ): SettlementRecord {
      if (records.has(id)) {
        throw new Error(`Settlement ${id} already exists`);
      }
      const profileName = options?.profileName ?? 'datacenter';
      const profile = resolveProfile(profileName);
      const now = Date.now();
      const record: SettlementRecord = {
        id,
        state: SettlementState.Pending,
        profile,
        txHash: options?.txHash,
        validBefore: options?.validBefore,
        createdAt: now,
        updatedAt: now,
      };
      records.set(id, record);
      return record;
    },

    get(id: string): SettlementRecord | undefined {
      return records.get(id);
    },

    transition(id: string, newState: SettlementState): SettlementRecord {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Settlement ${id} not found`);
      }
      record.state = newState;
      record.updatedAt = Date.now();
      records.set(id, record);
      return record;
    },

    list(): SettlementRecord[] {
      return Array.from(records.values());
    },
  };
}
