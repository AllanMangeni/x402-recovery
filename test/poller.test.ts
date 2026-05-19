import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createSettlementStateMachine, StateMachine } from '../src/state-machine';
import { pollUntilResolved } from '../src/poller';
import { SettlementState, PROFILES, ReceiptProvider, SettlementReceipt, normalizeValidBefore } from '../src/types';

function fakeReceiptProvider(receipts: Record<string, SettlementReceipt | Error | null>): ReceiptProvider {
  return {
    getTransactionReceipt: async ({ txHash }: { txHash: `0x${string}` }) => {
      const result = receipts[txHash];
      if (result instanceof Error) throw result;
      return result as SettlementReceipt | null;
    },
  };
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

  it('resolves to Confirmed when receipt succeeds within facilitator timeout', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-1', { profileName: 'datacenter', txHash });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    await pollUntilResolved({
      id: 'settlement-1',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
    });

    const record = machine.get('settlement-1');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('resolves to ConfirmedLate when receipt succeeds after facilitator timeout', async () => {
    const profile = {
      ...PROFILES.datacenter,
      facilitatorTimeoutMs: 1000,
      maxPollWindowMs: 30000,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const nowMs = profile.facilitatorTimeoutMs + 1;

    const record = machine.create('settlement-2', { profileName: 'datacenter', txHash });
    record.createdAt = 0;

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    await pollUntilResolved({
      id: 'settlement-2',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => nowMs,
    });

    const updated = machine.get('settlement-2');
    expect(updated!.state).toBe(SettlementState.ConfirmedLate);
  });

  it('resolves to Unresolved on non-transaction-not-found error', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-3', { profileName: 'datacenter', txHash });

    const fatalError = new Error('Internal server error');
    const receiptProvider = fakeReceiptProvider({
      [txHash]: fatalError,
    });

    await pollUntilResolved({
      id: 'settlement-3',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
    });

    const record = machine.get('settlement-3');
    expect(record!.state).toBe(SettlementState.Unresolved);
  });

  it('resolves to Failed on reverted receipt', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-4', { profileName: 'datacenter', txHash });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'reverted' },
    });

    await pollUntilResolved({
      id: 'settlement-4',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
    });

    const record = machine.get('settlement-4');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('resolves to Unresolved on unknown receipt status', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-unknown', { profileName: 'datacenter', txHash });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'unknown' },
    });

    await pollUntilResolved({
      id: 'settlement-unknown',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
    });

    const record = machine.get('settlement-unknown');
    expect(record!.state).toBe(SettlementState.Unresolved);
  });

  it('keeps polling on transaction-not-found error', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;

    machine.create('settlement-tnf', { profileName: 'datacenter', txHash });

    let callCount = 0;
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        callCount++;
        if (callCount <= 3) {
          throw fakeNotFoundError();
        }
        return { status: 'success', confirmations: 1 };
      },
    };

    const now = Date.now();
    await pollUntilResolved({
      id: 'settlement-tnf',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    expect(callCount).toBe(4);
    const record = machine.get('settlement-tnf');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('resolves to FailedOrphaned when poll window expires past validBefore (ms)', async () => {
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
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        callCount++;
        throw fakeNotFoundError();
      },
    };

    let time = startTime;
    await pollUntilResolved({
      id: 'settlement-5',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => {
        const current = time;
        time += profile.maxPollWindowMs + 1;
        return current;
      },
    });

    const record = machine.get('settlement-5');
    expect(record!.state).toBe(SettlementState.FailedOrphaned);
  });

  it('resolves to Failed when poll window expires without validBefore', async () => {
    const profile = {
      ...PROFILES.datacenter,
      maxPollWindowMs: 2000,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const startTime = 0;

    machine.create('settlement-6', { profileName: 'datacenter', txHash });

    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        throw fakeNotFoundError();
      },
    };

    let time = startTime;
    await pollUntilResolved({
      id: 'settlement-6',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => {
        const current = time;
        time += profile.maxPollWindowMs + 1;
        return current;
      },
    });

    const record = machine.get('settlement-6');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('resolves to Failed when poll window expires with future validBefore', async () => {
    const profile = {
      ...PROFILES.datacenter,
      maxPollWindowMs: 2000,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const startTime = 0;
    const futureValidBefore = startTime + 100_000;

    machine.create('settlement-future', {
      profileName: 'datacenter',
      txHash,
      validBefore: futureValidBefore,
    });

    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        throw fakeNotFoundError();
      },
    };

    let time = startTime;
    await pollUntilResolved({
      id: 'settlement-future',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => {
        const current = time;
        time += profile.maxPollWindowMs + 1;
        return current;
      },
    });

    const record = machine.get('settlement-future');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('throws when settlement record does not exist', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;

    const receiptProvider = fakeReceiptProvider({});
    await expect(
      pollUntilResolved({
        id: 'nonexistent',
        txHash,
        profile,
        machine,
        receiptProvider,
        now: () => Date.now(),
      }),
    ).rejects.toThrow('Settlement nonexistent not found');
  });

  it('continues polling when confirmations insufficient', async () => {
    const profile = {
      ...PROFILES.datacenter,
      requiredConfirmations: 3,
    };
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-conf', { profileName: 'datacenter', txHash });

    let callCount = 0;
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        callCount++;
        if (callCount < 3) {
          return { status: 'success', confirmations: callCount };
        }
        return { status: 'success', confirmations: 3 };
      },
    };

    await pollUntilResolved({
      id: 'settlement-conf',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    expect(callCount).toBe(3);
    const record = machine.get('settlement-conf');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('resolves to Unresolved when AbortSignal is aborted', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-abort', { profileName: 'datacenter', txHash });

    const controller = new AbortController();
    controller.abort();

    let delayCallCount = 0;
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        return null;
      },
    };

    await pollUntilResolved({
      id: 'settlement-abort',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      signal: controller.signal,
    });

    const record = machine.get('settlement-abort');
    expect(record!.state).toBe(SettlementState.Unresolved);
  });

  it('continues polling on null receipt', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('settlement-null', { profileName: 'datacenter', txHash });

    let callCount = 0;
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        callCount++;
        if (callCount <= 2) return null;
        return { status: 'success', confirmations: 1 };
      },
    };

    await pollUntilResolved({
      id: 'settlement-null',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    expect(callCount).toBe(3);
    const record = machine.get('settlement-null');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('works with async StateMachine adapter', async () => {
    const syncMachine = createSettlementStateMachine();

    const asyncMachine: StateMachine = {
      create: (id, opts) => syncMachine.create(id, opts),
      get: (id) => syncMachine.get(id),
      transition: (id, state) => syncMachine.transition(id, state),
      list: () => syncMachine.list(),
    };

    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    syncMachine.create('async-poll', { profileName: 'datacenter', txHash });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    const result = await pollUntilResolved({
      id: 'async-poll',
      txHash,
      profile,
      machine: asyncMachine,
      receiptProvider,
      now: () => now,
    });

    expect(result.state).toBe(SettlementState.Confirmed);
    expect(result.id).toBe('async-poll');

    const record = syncMachine.get('async-poll');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });
});
