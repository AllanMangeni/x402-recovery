import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PublicClient } from 'viem';
import { createSettlementStateMachine } from '../src/state-machine';
import { pollUntilResolved } from '../src/poller';
import { SettlementState, PROFILES } from '../src/types';

type FakeReceiptResult = { status: string } | Error;

function fakeClient(receipts: Record<string, FakeReceiptResult>): PublicClient {
  return {
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const result = receipts[hash];
      if (result instanceof Error) throw result;
      return result as { status: string };
    },
  } as unknown as PublicClient;
}

function fakeNotFoundError(): Error {
  const error = new Error('Transaction not found') as Error & { name: string; shortMessage: string };
  error.name = 'TransactionNotFoundError';
  error.shortMessage = 'Transaction not found';
  return error;
}

describe('pollUntilResolved', () => {
  let machine: ReturnType<typeof createSettlementStateMachine>;

  beforeEach(() => {
    machine = createSettlementStateMachine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves to confirmed when receipt succeeds within facilitator timeout', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-1', { profileName: 'datacenter', txHash });

    const client = fakeClient({
      [txHash]: { status: 'success' },
    });

    await pollUntilResolved({
      client,
      machine,
      id: 'settlement-1',
      txHash,
      profile,
      now: () => now,
    });

    const record = machine.get('settlement-1');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('resolves to confirmed_late when receipt succeeds after facilitator timeout', async () => {
    const profile = {
      ...PROFILES.datacenter,
      facilitatorTimeoutMs: 1000,
      maxPollWindowMs: 30000,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const nowMs = profile.facilitatorTimeoutMs + 1;

    const record = machine.create('settlement-2', { profileName: 'datacenter', txHash });
    record.createdAt = 0;

    const client = fakeClient({
      [txHash]: { status: 'success' },
    });

    await pollUntilResolved({
      client,
      machine,
      id: 'settlement-2',
      txHash,
      profile,
      now: () => nowMs,
    });

    const updated = machine.get('settlement-2');
    expect(updated!.state).toBe(SettlementState.ConfirmedLate);
  });

  it('resolves to unresolved on fatal RPC error', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-3', { profileName: 'datacenter', txHash });

    const fatalError = new Error('Internal server error') as Error & { name: string };
    fatalError.name = 'InternalError';

    const client = fakeClient({
      [txHash]: fatalError,
    });

    await pollUntilResolved({
      client,
      machine,
      id: 'settlement-3',
      txHash,
      profile,
      now: () => now,
    });

    const record = machine.get('settlement-3');
    expect(record!.state).toBe(SettlementState.Unresolved);
  });

  it('resolves to failed on reverted receipt', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-4', { profileName: 'datacenter', txHash });

    const client = fakeClient({
      [txHash]: { status: 'reverted' },
    });

    await pollUntilResolved({
      client,
      machine,
      id: 'settlement-4',
      txHash,
      profile,
      now: () => now,
    });

    const record = machine.get('settlement-4');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('resolves to failed_orphaned when poll window expires past validBefore', async () => {
    const profile = {
      ...PROFILES.datacenter,
      maxPollWindowMs: 2000,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const validBefore = 100;
    const startTime = 0;

    machine.create('settlement-5', {
      profileName: 'datacenter',
      txHash,
      validBefore,
    });

    let callCount = 0;
    const pollingClient = {
      getTransactionReceipt: async () => {
        callCount++;
        throw fakeNotFoundError();
      },
    } as unknown as PublicClient;

    let time = startTime;
    await pollUntilResolved({
      client: pollingClient,
      machine,
      id: 'settlement-5',
      txHash,
      profile,
      now: () => {
        const current = time;
        time += profile.maxPollWindowMs + 1;
        return current;
      },
    });

    const record = machine.get('settlement-5');
    expect(record!.state).toBe(SettlementState.FailedOrphaned);
  });

  it('resolves to failed when poll window expires without validBefore', async () => {
    const profile = {
      ...PROFILES.datacenter,
      maxPollWindowMs: 2000,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const startTime = 0;

    machine.create('settlement-6', { profileName: 'datacenter', txHash });

    const pollingClient = {
      getTransactionReceipt: async () => {
        throw fakeNotFoundError();
      },
    } as unknown as PublicClient;

    let time = startTime;
    await pollUntilResolved({
      client: pollingClient,
      machine,
      id: 'settlement-6',
      txHash,
      profile,
      now: () => {
        const current = time;
        time += profile.maxPollWindowMs + 1;
        return current;
      },
    });

    const record = machine.get('settlement-6');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('throws when settlement record does not exist', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;

    const client = fakeClient({});
    await expect(
      pollUntilResolved({
        client,
        machine,
        id: 'nonexistent',
        txHash,
        profile,
        now: () => Date.now(),
      }),
    ).rejects.toThrow('Settlement nonexistent not found');
  });
});
