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

export interface CreateSettlementOptions {
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
}

export interface StateMachine {
  create(
    id: string,
    opts?: CreateSettlementOptions,
  ): SettlementRecord | Promise<SettlementRecord>;

  get(
    id: string,
  ): SettlementRecord | undefined | Promise<SettlementRecord | undefined>;

  transition(
    id: string,
    newState: SettlementState,
  ): SettlementRecord | Promise<SettlementRecord>;

  list(): SettlementRecord[] | Promise<SettlementRecord[]>;
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

  function safeEmit(event: {
    settlementId: string;
    from: SettlementState;
    to: SettlementState;
    timestamp: number;
    txHash?: string;
    payer?: string;
    payTo?: string;
    value?: string;
    nonce?: string;
  }): void {
    if (!options?.onTransition) return;

    try {
      Promise.resolve(options.onTransition(event)).catch(() => {});
    } catch {}
  }

  return {
    create(
      id: string,
      opts?: CreateSettlementOptions,
    ): SettlementRecord {
      if (records.has(id)) {
        throw new Error(`Settlement ${id} already exists`);
      }
      const profile = opts?.profile ?? resolveProfile(opts?.profileName ?? 'datacenter');
      const now = Date.now();
      const record: SettlementRecord = {
        id,
        state: SettlementState.Created,
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

      safeEmit({
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

      return record;
    },

    list(): SettlementRecord[] {
      return Array.from(records.values());
    },
  };
}
