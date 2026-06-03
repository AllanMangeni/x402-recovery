import { randomUUID } from 'node:crypto';
import type { PublicClient } from 'viem';
import { createPublicClient, http } from 'viem';
import { createSettlementStateMachine, StateMachine, SettlementRecord } from './state-machine';
import { pollUntilResolved } from './poller';
import {
  SettlementState,
  SettlementProfile,
  ProfileName,
  PROFILES,
  ReceiptProvider,
  TERMINAL_STATES,
  normalizeValidBefore,
  AfterSettleTimeoutHook,
} from './types';
import { createViemReceiptProvider } from './adapters/viem';
import { RecoveryError } from './errors';

/**
 * Duck-typed context received from x402 v2 onSettleFailure / onUncertainSettlement hooks.
 * We do not depend on @x402/core directly; this shape is matched at runtime.
 */
export interface SettlementFailureContext {
  error: unknown;
  paymentPayload?: {
    from?: string;
    to?: string;
    value?: string;
    nonce?: string;
    validBefore?: number;
    deadline?: number;
    transaction?: { hash?: string };
  };
  requirements?: {
    amount?: string;
    network?: string;
    payTo?: string;
  };
  result?: {
    payer?: string;
    transaction?: { hash?: string };
  };
}

export interface RecoveryHookConfig {
  profile: ProfileName | SettlementProfile;
  rpcUrl?: string;
  client?: PublicClient;
  receiptProvider?: ReceiptProvider;
  stateMachine?: StateMachine;
  afterSettleTimeout?: AfterSettleTimeoutHook;
}

function logError(err: RecoveryError): void {
  console.error({
    event: err.code,
    ...err.toJSON(),
    timestamp: Date.now(),
  });
}



async function getOrCreateRecord(
  machine: StateMachine,
  id: string,
  opts: Parameters<StateMachine['create']>[1],
): Promise<SettlementRecord | undefined> {
  const existing = await machine.get(id);
  if (existing) return existing;
  try {
    return await machine.create(id, opts);
  } catch (createErr) {
    const retried = await machine.get(id);
    if (retried) return retried;
    throw createErr;
  }
}

/**
 * Create a recovery hook for x402 v2 onSettleFailure / onUncertainSettlement.
 *
 * The hook extracts payment identity from the context, creates a recovery record,
 * and starts polling in the background. It does not block the settlement flow.
 *
 * Usage:
 *   server.onSettleFailure(createRecoveryHook({ profile: 'datacenter', rpcUrl: '...' }));
 */
export function createRecoveryHook(config: RecoveryHookConfig) {
  const profile: SettlementProfile =
    typeof config.profile === 'string' ? PROFILES[config.profile] : config.profile;

  let receiptProvider: ReceiptProvider;
  if (config.receiptProvider) {
    receiptProvider = config.receiptProvider;
  } else if (config.client) {
    receiptProvider = createViemReceiptProvider(config.client);
  } else if (config.rpcUrl) {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    receiptProvider = createViemReceiptProvider(client);
  } else {
    throw new RecoveryError('hook_config_incomplete', 400, 'RecoveryHookConfig requires one of receiptProvider, client, or rpcUrl');
  }

  const machine = config.stateMachine ?? createSettlementStateMachine();

  return async function recoveryHook(context: SettlementFailureContext): Promise<void> {
    const settlementId =
      context.result?.transaction?.hash ??
      context.paymentPayload?.transaction?.hash ??
      `recovery-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const txHash = (
      context.result?.transaction?.hash ?? context.paymentPayload?.transaction?.hash
    ) as `0x${string}` | undefined;

    const payer = context.result?.payer ?? context.paymentPayload?.from;
    const payTo = context.requirements?.payTo ?? context.paymentPayload?.to;
    const value = context.requirements?.amount ?? context.paymentPayload?.value;
    const nonce = context.paymentPayload?.nonce;

    let validBefore: number | undefined;
    if (context.paymentPayload?.validBefore !== undefined) {
      validBefore = normalizeValidBefore(context.paymentPayload.validBefore);
    } else if (context.paymentPayload?.deadline !== undefined) {
      validBefore = normalizeValidBefore(context.paymentPayload.deadline);
    }

    const network = context.requirements?.network;

    let record: SettlementRecord | undefined;
    try {
      record = await getOrCreateRecord(machine, settlementId, {
        profile,
        txHash,
        payer,
        payTo,
        value,
        nonce,
        validBefore,
        network,
        scheme: 'exact',
      });
    } catch (err) {
      const error = err instanceof RecoveryError ? err : new RecoveryError('settlement_create_failed', 500, `Failed to create settlement record: ${settlementId}`, { settlementId, cause: String(err) });
      logError(error);
      return;
    }

    if (!record || TERMINAL_STATES.has(record.state)) {
      return;
    }

    if (!txHash) {
      try {
        await machine.transition(settlementId, SettlementState.Unresolved);
      } catch {}
      return;
    }

    if (config.afterSettleTimeout) {
      try {
        await Promise.resolve(
          config.afterSettleTimeout({
            payer,
            payTo,
            value,
            nonce,
            txHash,
            validBefore,
            network,
            scheme: 'exact',
          }),
        );
      } catch {}
    }

    // Fire-and-forget polling — never block the calling settlement flow.
    pollUntilResolved({
      id: settlementId,
      txHash,
      profile,
      machine,
      receiptProvider,
    }).catch((err) => {
      const error = err instanceof RecoveryError ? err : new RecoveryError('poller_failed', 500, `Poller failed for settlement: ${settlementId}`, { settlementId, cause: String(err) });
      logError(error);
      try {
        machine.transition(settlementId, SettlementState.Unresolved);
      } catch {}
    });
  };
}

/**
 * Convenience object for registering recovery on both x402 v2 hooks.
 * Spread into server hook registrations or attach individually.
 *
 * Usage:
 *   server.onSettleFailure(RecoveryPlugin({ profile: 'datacenter', rpcUrl: '...' }).onSettleFailure);
 *   server.onUncertainSettlement(RecoveryPlugin({ ... }).onUncertainSettlement);
 */
export function RecoveryPlugin(config: RecoveryHookConfig) {
  const hook = createRecoveryHook(config);
  return {
    onSettleFailure: hook,
    onUncertainSettlement: hook,
  };
}
