import { SettlementState, SettlementProfile, PROFILES, ProfileName, StateMachineOptions } from './types';
import { RecoveryError } from './errors';

export interface SettlementRecord {
  id: string;
  state: SettlementState;
  profile: SettlementProfile;
  scheme: 'exact' | 'batch';
  txHash?: string;
  claimTxHash?: string;
  settleTxHash?: string;
  validBefore?: number;
  createdAt: number;
  updatedAt: number;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
  simulationId?: string;
  bridgeRef?: string;
  network?: string;
  facilitatorResponse?: unknown;
}

export interface CreateSettlementOptions {
  profileName?: ProfileName;
  profile?: SettlementProfile;
  scheme?: 'exact' | 'batch';
  txHash?: string;
  claimTxHash?: string;
  settleTxHash?: string;
  validBefore?: number;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
  simulationId?: string;
  bridgeRef?: string;
  network?: string;
  facilitatorResponse?: unknown;
}

export interface SettlementRecordUpdate {
  txHash?: string;
  claimTxHash?: string;
  settleTxHash?: string;
  validBefore?: number;
  payer?: string;
  payTo?: string;
  value?: string;
  nonce?: string;
  network?: string;
  facilitatorResponse?: unknown;
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

  update(
    id: string,
    fields: SettlementRecordUpdate,
  ): SettlementRecord | Promise<SettlementRecord>;

  list(): SettlementRecord[] | Promise<SettlementRecord[]>;
}

export function createSettlementStateMachine(options?: StateMachineOptions): StateMachine {
  const records = new Map<string, SettlementRecord>();

  function resolveProfile(profileName: ProfileName): SettlementProfile {
    const profile = PROFILES[profileName];
    if (!profile) {
      throw new RecoveryError('profile_unknown', 400, `Unknown settlement profile: ${profileName}`, { profileName });
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
      Promise.resolve(options.onTransition(event)).catch((err) => {
        console.error({ event: 'transition.callback.error', error: String(err), settlementId: event.settlementId });
      });
    } catch (err) {
      console.error({ event: 'transition.callback.error', error: String(err), settlementId: event.settlementId });
    }
  }

  return {
    create(
      id: string,
      opts?: CreateSettlementOptions,
    ): SettlementRecord {
      if (records.has(id)) {
        throw new RecoveryError('settlement_already_exists', 409, `Settlement ${id} already exists`, { settlementId: id });
      }
      const profile = opts?.profile ?? resolveProfile(opts?.profileName ?? 'datacenter');
      const now = Date.now();
      const record: SettlementRecord = {
        id,
        state: SettlementState.Created,
        profile,
        scheme: opts?.scheme ?? 'exact',
        txHash: opts?.txHash,
        claimTxHash: opts?.claimTxHash,
        settleTxHash: opts?.settleTxHash,
        validBefore: opts?.validBefore,
        createdAt: now,
        updatedAt: now,
        payer: opts?.payer,
        payTo: opts?.payTo,
        value: opts?.value,
        nonce: opts?.nonce,
        simulationId: opts?.simulationId,
        bridgeRef: opts?.bridgeRef,
        network: opts?.network,
        facilitatorResponse: opts?.facilitatorResponse,
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
        throw new RecoveryError('settlement_not_found', 404, `Settlement ${id} not found`, { settlementId: id });
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

    update(id: string, fields: SettlementRecordUpdate): SettlementRecord {
      const record = records.get(id);
      if (!record) {
        throw new RecoveryError('settlement_not_found', 404, `Settlement ${id} not found`, { settlementId: id });
      }
      if (fields.txHash !== undefined) record.txHash = fields.txHash;
      if (fields.claimTxHash !== undefined) record.claimTxHash = fields.claimTxHash;
      if (fields.settleTxHash !== undefined) record.settleTxHash = fields.settleTxHash;
      if (fields.validBefore !== undefined) record.validBefore = fields.validBefore;
      if (fields.payer !== undefined) record.payer = fields.payer;
      if (fields.payTo !== undefined) record.payTo = fields.payTo;
      if (fields.value !== undefined) record.value = fields.value;
      if (fields.nonce !== undefined) record.nonce = fields.nonce;
      if (fields.network !== undefined) record.network = fields.network;
      if (fields.facilitatorResponse !== undefined) record.facilitatorResponse = fields.facilitatorResponse;
      record.updatedAt = Date.now();
      records.set(id, record);
      return record;
    },

    list(): SettlementRecord[] {
      return Array.from(records.values());
    },
  };
}
