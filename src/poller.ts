import { StateMachine } from './state-machine';
import { SettlementState, SettlementProfile, ReceiptProvider } from './types';

export interface PollUntilResolvedParams {
  id: string;
  txHash: `0x${string}`;
  profile: SettlementProfile;
  machine: StateMachine;
  receiptProvider: ReceiptProvider;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
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
  } = params;

  const record = await machine.get(id);

  if (!record) {
    throw new Error(`Settlement ${id} not found`);
  }

  const createdAt = record.createdAt;

  await machine.transition(id, SettlementState.Polling);

  const deadline = now() + profile.maxPollWindowMs;
  const requiredConfirmations = profile.requiredConfirmations ?? 1;

  while (now() < deadline) {
    if (signal?.aborted) {
      await machine.transition(id, SettlementState.Unresolved);
      return { id, state: SettlementState.Unresolved };
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
      return { id, state: SettlementState.Unresolved };
    }

    if (!receipt) {
      await delay(profile.pollIntervalMs);
      continue;
    }

    if (receipt.status === 'success') {
      const confirmations = receipt.confirmations ?? 1;
      if (confirmations < requiredConfirmations) {
        await delay(profile.pollIntervalMs);
        continue;
      }

      if (now() - createdAt <= profile.facilitatorTimeoutMs) {
        await machine.transition(id, SettlementState.Confirmed);
        return { id, state: SettlementState.Confirmed };
      } else {
        await machine.transition(id, SettlementState.ConfirmedLate);
        return { id, state: SettlementState.ConfirmedLate };
      }
    }

    if (receipt.status === 'reverted') {
      await machine.transition(id, SettlementState.Failed);
      return { id, state: SettlementState.Failed };
    }

    if (receipt.status === 'unknown') {
      await machine.transition(id, SettlementState.Unresolved);
      return { id, state: SettlementState.Unresolved };
    }

    await delay(profile.pollIntervalMs);
  }

  const updatedRecord = await machine.get(id);
  if (updatedRecord?.validBefore !== undefined && now() > updatedRecord.validBefore) {
    await machine.transition(id, SettlementState.FailedOrphaned);
    return { id, state: SettlementState.FailedOrphaned };
  }

  await machine.transition(id, SettlementState.Failed);
  return { id, state: SettlementState.Failed };
}
