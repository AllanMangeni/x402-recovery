import { SettlementState, SettlementProfile, PROFILES, ProfileName, StateMachineOptions } from './types';

export interface SettlementRecord {
  id: string;
  state: SettlementState;
  profile: SettlementProfile;
  txHash?: string;
  validBefore?: number;
  createdAt: number;
  updatedAt: number;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
  simulationId?: string;
  bridgeRef?: string;
}

export interface StateMachine {
  create(
    id: string,
    options?: {
      profileName?: ProfileName;
      profile?: SettlementProfile;
      txHash?: string;
      validBefore?: number;
      payer?: string;
      payTo?: string;
      value?: string;
      nonce?: string;
      simulationId?: string;
      bridgeRef?: string;
    },
  ): SettlementRecord;
  get(id: string): SettlementRecord | undefined;
  transition(id: string, newState: SettlementState): SettlementRecord;
  list(): SettlementRecord[];
}

export function createSettlementStateMachine(options?: StateMachineOptions): StateMachine {
  const records = new Map<string, SettlementRecord>();

  function resolveProfile(profileName: ProfileName): SettlementProfile {
    const profile = PROFILES[profileName];
    if (!profile) {
      throw new Error(`Unknown settlement profile: ${profileName}`);
    }
    return profile;
  }

  return {
    create(
      id: string,
      opts?: {
        profileName?: ProfileName;
        profile?: SettlementProfile;
        txHash?: string;
        validBefore?: number;
        payer?: string;
        payTo?: string;
        value?: string;
        nonce?: string;
        simulationId?: string;
        bridgeRef?: string;
      },
    ): SettlementRecord {
      if (records.has(id)) {
        throw new Error(`Settlement ${id} already exists`);
      }
      const profile = opts?.profile ?? resolveProfile(opts?.profileName ?? 'datacenter');
      const now = Date.now();
      const record: SettlementRecord = {
        id,
        state: SettlementState.Pending,
        profile,
        txHash: opts?.txHash,
        validBefore: opts?.validBefore,
        createdAt: now,
        updatedAt: now,
        payer: opts?.payer,
        payTo: opts?.payTo,
        value: opts?.value,
        nonce: opts?.nonce,
        simulationId: opts?.simulationId,
        bridgeRef: opts?.bridgeRef,
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
      const fromState = record.state;
      record.state = newState;
      record.updatedAt = Date.now();
      records.set(id, record);
      if (options?.onTransition) {
        try {
          options.onTransition({
            settlementId: id,
            from: fromState,
            to: newState,
            timestamp: record.updatedAt,
            txHash: record.txHash,
            payer: record.payer,
            payTo: record.payTo,
            value: record.value,
            nonce: record.nonce,
          });
        } catch {
          // callback errors must never break the state machine
        }
      }
      return record;
    },

    list(): SettlementRecord[] {
      return Array.from(records.values());
    },
  };
}
