import { Hash, PublicClient } from 'viem';
import { StateMachine } from './state-machine';
import { SettlementState, SettlementProfile } from './types';

export interface PollUntilResolvedParams {
  client: PublicClient;
  machine: StateMachine;
  id: string;
  txHash: Hash;
  profile: SettlementProfile;
  now?: () => number;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTransactionNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'TransactionNotFoundError') {
      return true;
    }
    if ('shortMessage' in error && typeof (error as Record<string, unknown>).shortMessage === 'string') {
      return ((error as Record<string, unknown>).shortMessage as string).includes('Transaction not found');
    }
  }
  return false;
}

export async function pollUntilResolved(params: PollUntilResolvedParams): Promise<void> {
  const { client, machine, id, txHash, profile, now = Date.now } = params;

  const record = machine.get(id);
  if (!record) {
    throw new Error(`Settlement ${id} not found`);
  }

  machine.transition(id, SettlementState.Polling);

  const deadline = now() + profile.maxPollWindowMs;
  const createdAt = record.createdAt;

  while (now() < deadline) {
    let receipt: { status: string } | null;

    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if (isTransactionNotFoundError(error)) {
        await delay(profile.pollIntervalMs);
        continue;
      }
      machine.transition(id, SettlementState.Unresolved);
      return;
    }

    if (!receipt) {
      await delay(profile.pollIntervalMs);
      continue;
    }

    if (receipt.status === 'success') {
      if (now() - createdAt <= profile.facilitatorTimeoutMs) {
        machine.transition(id, SettlementState.Confirmed);
      } else {
        machine.transition(id, SettlementState.ConfirmedLate);
      }
      return;
    }

    if (receipt.status === 'reverted') {
      machine.transition(id, SettlementState.Failed);
      return;
    }

    await delay(profile.pollIntervalMs);
  }

  if (record.validBefore !== undefined && now() > record.validBefore) {
    machine.transition(id, SettlementState.FailedOrphaned);
  } else {
    machine.transition(id, SettlementState.Failed);
  }
}
