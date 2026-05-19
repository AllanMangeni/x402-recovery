import { Request, Response, NextFunction } from 'express';
import { PublicClient, createPublicClient, http } from 'viem';
import { createSettlementStateMachine, StateMachine } from './state-machine';
import { pollUntilResolved } from './poller';
import { PROFILES, ProfileName, SettlementState, SettlementProfile, SettlementContext, ReceiptProvider, canonicalKey, normalizeValidBefore, TERMINAL_STATES } from './types';
import { createViemReceiptProvider } from './adapters/viem';

declare global {
  namespace Express {
    interface Locals {
      x402Settlement?: SettlementContext;
    }
  }
}

export interface PollDispatcher {
  dispatchPoll(input: {
    settlementId: string;
    canonicalKey?: string;
    txHash: `0x${string}`;
    profile: SettlementProfile;
    validBefore?: number;
  }): void | Promise<void>;
}

export interface RecoveryConfig {
  profile: ProfileName | SettlementProfile;
  rpcUrl?: string;
  client?: PublicClient;
  receiptProvider?: ReceiptProvider;
  stateMachine?: StateMachine;
  pollDispatcher?: PollDispatcher;
}

function logError(message: string, details: Record<string, unknown>): void {
  console.error({
    event: message,
    ...details,
    timestamp: Date.now(),
  });
}

export function createRecoveryMiddleware(config: RecoveryConfig) {
  const profile: SettlementProfile =
    typeof config.profile === 'string' ? PROFILES[config.profile] : config.profile;
  const machine = config.stateMachine ?? createSettlementStateMachine();

  if (config.pollDispatcher && !config.stateMachine) {
    throw new Error('RecoveryConfig: pollDispatcher requires stateMachine for shared state');
  }

  let receiptProvider: ReceiptProvider;
  if (config.receiptProvider) {
    receiptProvider = config.receiptProvider;
  } else if (config.client) {
    receiptProvider = createViemReceiptProvider(config.client);
  } else if (config.rpcUrl) {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    receiptProvider = createViemReceiptProvider(client);
  } else {
    throw new Error('RecoveryConfig requires one of receiptProvider, client, or rpcUrl');
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    next();

    const ctx = res.locals?.x402Settlement;
    if (!ctx?.timedOut) {
      return;
    }

    const { settlementId, txHash, payer, payTo, value, nonce } = ctx;

    let validBefore: number | undefined;
    if (ctx.validBefore !== undefined) {
      validBefore = normalizeValidBefore(ctx.validBefore);
    }

    let ck: string | undefined;
    if (payer && payTo && value && nonce) {
      ck = canonicalKey({ payer, payTo, value, nonce });
    }

    const hasTxHash = typeof txHash === 'string' && txHash.length > 0;

    let record = machine.get(settlementId);
    const existingRecord = (record instanceof Promise ? undefined : record);
    if (!existingRecord) {
      try {
        record = machine.create(settlementId, {
          profile,
          txHash: hasTxHash ? (txHash as `0x${string}`) : undefined,
          validBefore,
          payer,
          payTo,
          value,
          nonce,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) {
          record = machine.get(settlementId);
        } else {
          throw err;
        }
      }
      if (record instanceof Promise) {
        record = await record;
      }
    } else if (existingRecord instanceof Promise) {
      record = await existingRecord;
    } else {
      record = existingRecord;
    }

    if (!hasTxHash) {
      try {
        machine.transition(settlementId, SettlementState.Unresolved);
      } catch {}
      return;
    }

    const typedTxHash = txHash as `0x${string}`;

    if (config.pollDispatcher) {
      try {
        const dispatchResult = config.pollDispatcher.dispatchPoll({
          settlementId,
          canonicalKey: ck,
          txHash: typedTxHash,
          profile,
          validBefore,
        });
        if (dispatchResult instanceof Promise) {
          dispatchResult.catch((err) => {
            logError('settlement.dispatcher.error', {
              settlementId,
              error: String(err),
            });
          });
        }
      } catch (err) {
        logError('settlement.dispatcher.error', {
          settlementId,
          error: String(err),
        });
      }
      return;
    }

    pollUntilResolved({
      id: settlementId,
      txHash: typedTxHash,
      profile,
      machine,
      receiptProvider,
    }).catch((err) => {
      logError('settlement.poller.error', {
        settlementId,
        error: String(err),
      });
      try {
        machine.transition(settlementId, SettlementState.Unresolved);
      } catch {}
    });
  };
}
