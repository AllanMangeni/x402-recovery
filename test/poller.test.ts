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
    ).rejects.toThrow(expect.objectContaining({ code: 'settlement_not_found' }));
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
      update: (id, fields) => syncMachine.update(id, fields),
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

describe('v0.3.0 — batch path full transition', () => {
  let machine: ReturnType<typeof createSettlementStateMachine>;

  beforeEach(() => {
    machine = createSettlementStateMachine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('follows Created → ClaimPending → ClaimConfirmed → SettlePending → SettleConfirmed', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimdead' as `0x${string}`;
    const settleTxHash = '0xsettledead' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-1', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-1', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'success', confirmations: 1 },
    });

    await pollUntilResolved({
      id: 'batch-1',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    const record = machine.get('batch-1');
    expect(record!.state).toBe(SettlementState.SettleConfirmed);
  });

  it('transitions through all batch intermediate states', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaiminter' as `0x${string}`;
    const settleTxHash = '0xsettleinter' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-inter', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-inter', { settleTxHash });

    const states: SettlementState[] = [];
    const onTransition = (event: { to: SettlementState }) => {
      states.push(event.to);
    };
    machine = createSettlementStateMachine({ onTransition });

    machine.create('batch-inter', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-inter', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'success', confirmations: 1 },
    });

    await pollUntilResolved({
      id: 'batch-inter',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    expect(states).toContain(SettlementState.ClaimPending);
    expect(states).toContain(SettlementState.ClaimConfirmed);
    expect(states).toContain(SettlementState.SettlePending);
    expect(states).toContain(SettlementState.SettleConfirmed);
  });
});

describe('v0.3.0 — batch path claim vs settle txHash', () => {
  let machine: ReturnType<typeof createSettlementStateMachine>;

  beforeEach(() => {
    machine = createSettlementStateMachine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks claimTxHash during ClaimPending → ClaimConfirmed', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimonly' as `0x${string}`;
    const settleTxHash = '0xsettleonly' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-claim-check', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-claim-check', { settleTxHash });

    const txHashesQueried: string[] = [];
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async ({ txHash }) => {
        txHashesQueried.push(txHash);
        if (txHash === claimTxHash) {
          return { status: 'success', confirmations: 1 };
        }
        if (txHash === settleTxHash) {
          return { status: 'success', confirmations: 1 };
        }
        return null;
      },
    };

    await pollUntilResolved({
      id: 'batch-claim-check',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    expect(txHashesQueried).toContain(claimTxHash);
    expect(txHashesQueried).toContain(settleTxHash);
  });

  it('settleTxHash absent on record creation, set via update', async () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('batch-no-settle-at-create', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash: '0xclaim1',
    });

    expect(record.settleTxHash).toBeUndefined();

    machine.update('batch-no-settle-at-create', { settleTxHash: '0xsettle1' });

    const updated = machine.get('batch-no-settle-at-create');
    expect(updated!.settleTxHash).toBe('0xsettle1');
  });
});

describe('v0.3.0 — indexerLagMs delay', () => {
  let machine: ReturnType<typeof createSettlementStateMachine>;

  beforeEach(() => {
    machine = createSettlementStateMachine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('respects indexerLagMs delay between ClaimConfirmed and SettlePending', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimlag' as `0x${string}`;
    const settleTxHash = '0xsettlelag' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-lag', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-lag', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'success', confirmations: 1 },
    });

    const delays: number[] = [];
    const recordDelay = async (ms: number) => {
      delays.push(ms);
    };

    await pollUntilResolved({
      id: 'batch-lag',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: recordDelay,
    });

    expect(delays).toContain(10_000);
  });

  it('defaults indexerLagMs to 10_000 for batch profile when not set', async () => {
    const profile = {
      ...PROFILES.batch,
      indexerLagMs: undefined,
    };
    const claimTxHash = '0xclaimdefaultlag' as `0x${string}`;
    const settleTxHash = '0xsettledefaultlag' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-default-lag', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-default-lag', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'success', confirmations: 1 },
    });

    const delays: number[] = [];
    const recordDelay = async (ms: number) => {
      delays.push(ms);
    };

    await pollUntilResolved({
      id: 'batch-default-lag',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: recordDelay,
    });

    expect(delays).toContain(10_000);
  });

  it('settle phase does not execute before indexerLagMs elapses', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimprelag' as `0x${string}`;
    const settleTxHash = '0xsettleprelag' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-prelag', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-prelag', { settleTxHash });

    let settlePollCalled = false;
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async ({ txHash }) => {
        if (txHash === claimTxHash) {
          const state = machine.get('batch-prelag')!.state;
          if (state === SettlementState.SettlePending) {
            settlePollCalled = true;
          }
          return { status: 'success', confirmations: 1 };
        }
        if (txHash === settleTxHash) {
          return { status: 'success', confirmations: 1 };
        }
        return null;
      },
    };

    const delays: number[] = [];
    let claimConfirmedTime = 0;
    let settlePendingTime = Infinity;

    const recordDelay = async (ms: number) => {
      delays.push(ms);
      const currentState = machine.get('batch-prelag')!.state;
      if (currentState === SettlementState.ClaimConfirmed) {
        claimConfirmedTime = delays.length;
      }
      if (currentState === SettlementState.SettlePending && settlePendingTime === Infinity) {
        settlePendingTime = delays.length;
      }
    };

    await pollUntilResolved({
      id: 'batch-prelag',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: recordDelay,
    });

    expect(settlePollCalled).toBe(false);
  });
});

describe('v0.3.0 — batch path terminal states', () => {
  let machine: ReturnType<typeof createSettlementStateMachine>;

  beforeEach(() => {
    machine = createSettlementStateMachine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves to ConfirmedLate from settle phase after facilitator timeout', async () => {
    const profile = {
      ...PROFILES.batch,
      facilitatorTimeoutMs: 1000,
      maxPollWindowMs: 30000,
    };
    const claimTxHash = '0xclaimlate' as `0x${string}`;
    const settleTxHash = '0xsettlelate' as `0x${string}`;
    const nowMs = profile.facilitatorTimeoutMs + 1;

    const record = machine.create('batch-late', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    record.createdAt = 0;
    machine.update('batch-late', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'success', confirmations: 1 },
    });

    await pollUntilResolved({
      id: 'batch-late',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => nowMs,
      delay: () => Promise.resolve(),
    });

    const updated = machine.get('batch-late');
    expect(updated!.state).toBe(SettlementState.ConfirmedLate);
  });

  it('resolves to Failed from claim phase on reverted receipt', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimrevert' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-claim-fail', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'reverted' },
    });

    await pollUntilResolved({
      id: 'batch-claim-fail',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    const record = machine.get('batch-claim-fail');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('resolves to Failed from settle phase on reverted receipt', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimsettlefail' as `0x${string}`;
    const settleTxHash = '0xsettlefail' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-settle-fail', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });
    machine.update('batch-settle-fail', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'reverted' },
    });

    await pollUntilResolved({
      id: 'batch-settle-fail',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    const record = machine.get('batch-settle-fail');
    expect(record!.state).toBe(SettlementState.Failed);
  });

  it('resolves to FailedOrphaned on validBefore expiry in claim phase', async () => {
    const profile = {
      ...PROFILES.batch,
      maxPollWindowMs: 1000,
    };
    const claimTxHash = '0xclaimorphan' as `0x${string}`;
    const validBefore = 100;
    const startTime = 0;

    machine.create('batch-claim-orphan', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
      validBefore,
    });

    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async () => {
        throw fakeNotFoundError();
      },
    };

    let time = startTime;
    await pollUntilResolved({
      id: 'batch-claim-orphan',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => {
        const current = time;
        time += profile.maxPollWindowMs + 1;
        return current;
      },
    });

    const record = machine.get('batch-claim-orphan');
    expect(record!.state).toBe(SettlementState.FailedOrphaned);
  });

  it('resolves to FailedOrphaned on validBefore expiry in settle phase', async () => {
    const profile = {
      ...PROFILES.batch,
      maxPollWindowMs: 1000,
    };
    const claimTxHash = '0xclaimsettleorphan' as `0x${string}`;
    const settleTxHash = '0xsettleorphan' as `0x${string}`;
    const validBefore = 100;

    machine.create('batch-settle-orphan', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
      validBefore,
    });
    machine.update('batch-settle-orphan', { settleTxHash });

    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async ({ txHash }) => {
        if (txHash === claimTxHash) {
          return { status: 'success', confirmations: 1 };
        }
        throw fakeNotFoundError();
      },
    };

    let time = 0;
    await pollUntilResolved({
      id: 'batch-settle-orphan',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => {
        const current = time;
        if (time === 0) {
          time = 2;
        } else {
          time += profile.maxPollWindowMs + 1;
        }
        return current;
      },
      delay: () => Promise.resolve(),
    });

    const record = machine.get('batch-settle-orphan');
    expect(record!.state).toBe(SettlementState.FailedOrphaned);
  });

  it('resolves to Unresolved on non-TNF error in claim phase', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimunresolved' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-claim-unresolved', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });

    const fatalError = new Error('RPC error');
    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: fatalError,
    });

    await pollUntilResolved({
      id: 'batch-claim-unresolved',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: () => Promise.resolve(),
    });

    const record = machine.get('batch-claim-unresolved');
    expect(record!.state).toBe(SettlementState.Unresolved);
  });
});

describe('v0.3.0 — afterSettleTimeout hook', () => {
  let machine: ReturnType<typeof createSettlementStateMachine>;

  beforeEach(() => {
    machine = createSettlementStateMachine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires at poller start for exact scheme', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('hook-exact', {
      profileName: 'datacenter',
      txHash,
      payer: '0xpayer',
      payTo: '0xpayto',
      value: '100',
      nonce: '1',
      network: 'base-sepolia',
    });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    const hook = vi.fn();

    await pollUntilResolved({
      id: 'hook-exact',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      afterSettleTimeout: hook,
    });

    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0][0]).toMatchObject({
      payer: '0xpayer',
      payTo: '0xpayto',
      value: '100',
      nonce: '1',
      txHash: '0xdeadbeef',
      network: 'base-sepolia',
      scheme: 'exact',
    });
  });

  it('fires at poller start for batch scheme', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimhook' as `0x${string}`;
    const settleTxHash = '0xsettlehook' as `0x${string}`;
    const now = Date.now();

    machine.create('hook-batch', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
      payer: '0xpayer',
      payTo: '0xpayto',
      nonce: '1',
    });
    machine.update('hook-batch', { settleTxHash });

    const receiptProvider = fakeReceiptProvider({
      [claimTxHash]: { status: 'success', confirmations: 1 },
      [settleTxHash]: { status: 'success', confirmations: 1 },
    });

    const hook = vi.fn();

    await pollUntilResolved({
      id: 'hook-batch',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      afterSettleTimeout: hook,
      delay: () => Promise.resolve(),
    });

    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0][0]).toMatchObject({
      payer: '0xpayer',
      payTo: '0xpayto',
      nonce: '1',
      scheme: 'batch',
    });
  });

  it('hook has undefined for unset fields, not empty strings', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('hook-sparse', {
      profileName: 'datacenter',
      txHash,
    });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    const hook = vi.fn();

    await pollUntilResolved({
      id: 'hook-sparse',
      txHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      afterSettleTimeout: hook,
    });

    const payload = hook.mock.calls[0][0];
    expect(payload.payer).toBeUndefined();
    expect(payload.payTo).toBeUndefined();
    expect(payload.value).toBeUndefined();
    expect(payload.nonce).toBeUndefined();
    expect(payload.network).toBeUndefined();
    expect(payload.facilitatorResponse).toBeUndefined();
    expect(payload.validBefore).toBeUndefined();
  });

  it('hook sync error does not crash poller', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('hook-sync-err', { profileName: 'datacenter', txHash });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    const hook = vi.fn(() => {
      throw new Error('hook sync error');
    });

    await expect(
      pollUntilResolved({
        id: 'hook-sync-err',
        txHash,
        profile,
        machine,
        receiptProvider,
        now: () => now,
        afterSettleTimeout: hook,
      }),
    ).resolves.toBeDefined();

    const record = machine.get('hook-sync-err');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('hook async rejection does not crash poller', async () => {
    const profile = PROFILES.datacenter;
    const txHash = '0xdeadbeef' as `0x${string}`;
    const now = Date.now();

    machine.create('hook-async-err', { profileName: 'datacenter', txHash });

    const receiptProvider = fakeReceiptProvider({
      [txHash]: { status: 'success', confirmations: 1 },
    });

    const hook = vi.fn(() => Promise.reject(new Error('hook async error')));

    await expect(
      pollUntilResolved({
        id: 'hook-async-err',
        txHash,
        profile,
        machine,
        receiptProvider,
        now: () => now,
        afterSettleTimeout: hook,
      }),
    ).resolves.toBeDefined();

    const record = machine.get('hook-async-err');
    expect(record!.state).toBe(SettlementState.Confirmed);
  });

  it('settleTxHash absent: poller waits until set then succeeds', async () => {
    const profile = PROFILES.batch;
    const claimTxHash = '0xclaimwait' as `0x${string}`;
    const settleTxHash = '0xsettlewait' as `0x${string}`;
    const now = Date.now();

    machine.create('batch-wait-settle', {
      profileName: 'batch',
      scheme: 'batch',
      claimTxHash,
    });

    let settleRequestCount = 0;
    const receiptProvider: ReceiptProvider = {
      getTransactionReceipt: async ({ txHash }) => {
        if (txHash === claimTxHash) {
          return { status: 'success', confirmations: 1 };
        }
        if (txHash === settleTxHash) {
          settleRequestCount++;
          return { status: 'success', confirmations: 1 };
        }
        return null;
      },
    };

    let settleHashSet = false;
    const recordDelay = async (ms: number) => {
      if (!settleHashSet) {
        machine.update('batch-wait-settle', { settleTxHash });
        settleHashSet = true;
      }
    };

    await pollUntilResolved({
      id: 'batch-wait-settle',
      txHash: claimTxHash,
      profile,
      machine,
      receiptProvider,
      now: () => now,
      delay: recordDelay,
    });

    const record = machine.get('batch-wait-settle');
    expect(record!.state).toBe(SettlementState.SettleConfirmed);
    expect(record!.settleTxHash).toBe(settleTxHash);
  });
});
