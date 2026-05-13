import { SettlementState, SettlementProfile, PROFILES } from './types';

export interface SettlementRecord {
  id: string;
  state: SettlementState;
  profile: SettlementProfile;
  createdAt: number;
  updatedAt: number;
  confirmations: number;
}

export interface StateMachine {
  create(id: string, profileName?: string): SettlementRecord;
  get(id: string): SettlementRecord | undefined;
  transition(id: string, newState: SettlementState): SettlementRecord;
  list(): SettlementRecord[];
}

export function createSettlementStateMachine(): StateMachine {
  const records = new Map<string, SettlementRecord>();

  function resolveProfile(profileName: string): SettlementProfile {
    const profile = PROFILES[profileName];
    if (!profile) {
      throw new Error(`Unknown settlement profile: ${profileName}`);
    }
    return profile;
  }

  return {
    create(id: string, profileName = 'standard'): SettlementRecord {
      if (records.has(id)) {
        throw new Error(`Settlement ${id} already exists`);
      }
      const profile = resolveProfile(profileName);
      const now = Date.now();
      const record: SettlementRecord = {
        id,
        state: SettlementState.Pending,
        profile,
        createdAt: now,
        updatedAt: now,
        confirmations: 0,
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
