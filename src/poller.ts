import { StateMachine } from './state-machine';
import { SettlementState, SettlementProfile, ReceiptProvider, AfterSettleTimeoutHook } from './types';

export interface PollUntilResolvedParams {
  id: string;
  txHash: `0x${string}`;
  profile: SettlementProfile;
  machine: StateMachine;
  receiptProvider: ReceiptProvider;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  afterSettleTimeout?: AfterSettleTimeoutHook;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransactionNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'TransactionNotFoundError') {
      return true;
    }
    if ('shortMessage' in error && typeof (error as Record<string, unknown>).shortMessage === 'string') {
      return ((error as Record<string, unknown>).shortMessage as string).includes('Transaction not found');
    }
    const message = error.message.toLowerCase();
    if (message.includes('not found') || message.includes('could not be found')) {
      return true;
    }
  }
  return false;
}

async function pollReceiptLoop(params: {
  id: string;
  txHash: `0x${string}`;
  profile: SettlementProfile;
  machine: StateMachine;
  receiptProvider: ReceiptProvider;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  signal: AbortSignal | undefined;
  createdAt: number;
  deadline: number;
  successState: SettlementState;
}): Promise<SettlementState> {
  const {
    id, txHash, profile, machine, receiptProvider,
    now, delay, signal, createdAt, deadline, successState,
  } = params;
  const requiredConfirmations = profile.requiredConfirmations ?? 1;

  while (now() < deadline) {
    if (signal?.aborted) {
      await machine.transition(id, SettlementState.Unresolved);
      return SettlementState.Unresolved;
    }

    let receipt;
    try {
      receipt = await receiptProvider.getTransactionReceipt({ txHash });
    } catch (error) {
      if (isTransactionNotFoundError(error)) {
        await delay(profile.pollIntervalMs);
        continue;
      }
      await machine.transition(id, SettlementState.Unresolved);
      return SettlementState.Unresolved;
    }

    if (!receipt) {
      await delay(profile.pollIntervalMs);
      continue;
    }

    if (receipt.status === 'success') {
      if (receipt.confirmations !== undefined && receipt.confirmations < requiredConfirmations) {
        await delay(profile.pollIntervalMs);
        continue;
      }
      if (receipt.confirmations === undefined && requiredConfirmations > 1) {
        await delay(profile.pollIntervalMs);
        continue;
      }

      if (now() - createdAt <= profile.facilitatorTimeoutMs) {
        await machine.transition(id, successState);
        return successState;
      } else {
        await machine.transition(id, SettlementState.ConfirmedLate);
        return SettlementState.ConfirmedLate;
      }
    }

    if (receipt.status === 'reverted') {
      await machine.transition(id, SettlementState.Failed);
      return SettlementState.Failed;
    }

    if (receipt.status === 'unknown') {
      await machine.transition(id, SettlementState.Unresolved);
      return SettlementState.Unresolved;
    }

    await delay(profile.pollIntervalMs);
  }

  const updatedRecord = await machine.get(id);
  if (updatedRecord?.validBefore !== undefined && now() > updatedRecord.validBefore) {
    await machine.transition(id, SettlementState.FailedOrphaned);
    return SettlementState.FailedOrphaned;
  }

  await machine.transition(id, SettlementState.Failed);
  return SettlementState.Failed;
}

export async function pollUntilResolved(
  params: PollUntilResolvedParams,
): Promise<{ id: string; state: SettlementState }> {
  const {
    id,
    txHash,
    profile,
    machine,
    receiptProvider,
    now = Date.now,
    delay = defaultDelay,
    signal,
    afterSettleTimeout,
  } = params;

  const record = await machine.get(id);

  if (!record) {
    throw new Error(`Settlement ${id} not found`);
  }

  const createdAt = record.createdAt;
  const scheme = record.scheme;
  const deadline = now() + profile.maxPollWindowMs;

  if (afterSettleTimeout) {
    try {
      await Promise.resolve(afterSettleTimeout({
        payer: record.payer,
        payTo: record.payTo,
        value: record.value,
        nonce: record.nonce,
        txHash: record.txHash,
        validBefore: record.validBefore,
        network: record.network,
        facilitatorResponse: record.facilitatorResponse,
        scheme,
      }));
    } catch {}
  }

  if (scheme === 'batch') {
    return pollBatchPath(id, txHash, profile, machine, receiptProvider, now, delay, signal, createdAt, deadline);
  }

  await machine.transition(id, SettlementState.Polling);

  const state = await pollReceiptLoop({
    id, txHash, profile, machine, receiptProvider,
    now, delay, signal, createdAt, deadline,
    successState: SettlementState.Confirmed,
  });

  return { id, state };
}

async function pollBatchPath(
  id: string,
  fallbackTxHash: `0x${string}`,
  profile: SettlementProfile,
  machine: StateMachine,
  receiptProvider: ReceiptProvider,
  now: () => number,
  delay: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  createdAt: number,
  deadline: number,
): Promise<{ id: string; state: SettlementState }> {
  await machine.transition(id, SettlementState.ClaimPending);

  const record = await machine.get(id);
  const claimTxHash = (record?.claimTxHash ?? fallbackTxHash) as `0x${string}`;

  const claimResult = await pollReceiptLoop({
    id, txHash: claimTxHash, profile, machine, receiptProvider,
    now, delay, signal, createdAt, deadline,
    successState: SettlementState.ClaimConfirmed,
  });

  if (claimResult !== SettlementState.ClaimConfirmed) {
    return { id, state: claimResult };
  }

  const indexerLagMs = profile.indexerLagMs ?? 10_000;
  await delay(indexerLagMs);

  await machine.transition(id, SettlementState.SettlePending);

  const settleResult = await pollSettlePhase(
    id, profile, machine, receiptProvider, now, delay, signal, createdAt, deadline,
  );

  return { id, state: settleResult };
}

async function pollSettlePhase(
  id: string,
  profile: SettlementProfile,
  machine: StateMachine,
  receiptProvider: ReceiptProvider,
  now: () => number,
  delay: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  createdAt: number,
  deadline: number,
): Promise<SettlementState> {
  while (now() < deadline) {
    const currentRecord = await machine.get(id);
    if (!currentRecord?.settleTxHash) {
      await delay(profile.pollIntervalMs);
      continue;
    }

    const settleTxHash = currentRecord.settleTxHash as `0x${string}`;
    return pollReceiptLoop({
      id, txHash: settleTxHash, profile, machine, receiptProvider,
      now, delay, signal, createdAt, deadline,
      successState: SettlementState.SettleConfirmed,
    });
  }

  const updatedRecord = await machine.get(id);
  if (updatedRecord?.validBefore !== undefined && now() > updatedRecord.validBefore) {
    await machine.transition(id, SettlementState.FailedOrphaned);
    return SettlementState.FailedOrphaned;
  }

  await machine.transition(id, SettlementState.Failed);
  return SettlementState.Failed;
}
