import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { createSettlementStateMachine, StateMachine, SettlementRecord, CreateSettlementOptions } from '../src/state-machine';
import { SettlementState, SettlementProfile, ReceiptProvider, TERMINAL_STATES } from '../src/types';
import { createRecoveryMiddleware, PollDispatcher } from '../src/middleware';
import * as pollerModule from '../src/poller';

function fakeReceiptProvider(): ReceiptProvider {
  return {
    getTransactionReceipt: async () => ({ status: 'success', confirmations: 1 }),
  };
}

function fakeReq(overrides?: Partial<Request>): Request {
  return { ...overrides } as Request;
}

function fakeRes(overrides?: Partial<Response>): Response {
  const res = {
    locals: {} as Record<string, unknown>,
    ...overrides,
  } as Response;
  return res;
}

function makeAsyncMachine(
  syncMachine: ReturnType<typeof createSettlementStateMachine>,
): StateMachine {
  return {
    create: (id, opts) => Promise.resolve(syncMachine.create(id, opts)),
    get: (id) => Promise.resolve(syncMachine.get(id)),
    transition: (id, state) => Promise.resolve(syncMachine.transition(id, state)),
    list: () => Promise.resolve(syncMachine.list()),
  };
}

describe('createRecoveryMiddleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through when no settlement context is attached', () => {
    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through when settlement context has timedOut: false', () => {
    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });
    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: { settlementId: 'tx-1', txHash: '0xabc', timedOut: false },
      },
    });
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('calls pollUntilResolved when settlement context has timedOut: true', async () => {
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue({
      id: 'tx-timedout',
      state: SettlementState.Confirmed,
    });

    const machine = createSettlementStateMachine();
    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-timedout',
          txHash: '0xdead',
          validBefore: 2000000000000,
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

    await middlewarePromise;

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
        const callArgs = pollSpy.mock.calls[0][0];
        expect(callArgs.id).toBe('tx-timedout');
        expect(callArgs.txHash).toBe('0xdead');
      },
      { timeout: 200 },
    );
  });

  it('transitions to Unresolved when timedOut but no txHash', async () => {
    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-no-hash',
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

    await middlewarePromise;

    const record = machine.get('tx-no-hash');
    expect(record).toBeDefined();
    expect(record!.state).toBe(SettlementState.Unresolved);
  });

  it('transitions to Unresolved and logs when poller rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(pollerModule, 'pollUntilResolved').mockRejectedValue(new Error('RPC timeout'));

    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-poller-fail',
          txHash: '0xdead',
          validBefore: 2000000000000,
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

    await middlewarePromise;

    await vi.waitFor(
      () => {
        expect(consoleSpy).toHaveBeenCalled();
        const logArg = consoleSpy.mock.calls[0][0] as Record<string, unknown>;
        expect(logArg.event).toBe('settlement.poller.error');
        expect(logArg.settlementId).toBe('tx-poller-fail');

        const record = machine.get('tx-poller-fail');
        expect(record?.state).toBe(SettlementState.Unresolved);
      },
      { timeout: 200 },
    );

    consoleSpy.mockRestore();
  });

  it('isolates 50 concurrent settlements without cross-contamination', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '', state: SettlementState.Confirmed });

    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const count = 50;
    const promises = Array.from({ length: count }, (_, i) => {
      return new Promise<void>((resolve) => {
        const req = fakeReq();
        const res = fakeRes({
          locals: {
            x402Settlement: {
              settlementId: `tx-concurrent-${i}`,
              txHash: `0x${String(i).padStart(64, '0')}` as `0x${string}`,
              validBefore: 2000000000000,
              timedOut: true,
            },
          },
        });
        middleware(req, res, () => resolve());
      });
    });

    await Promise.all(promises);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledTimes(count);
      },
      { timeout: 500 },
    );

    const records = machine.list();
    expect(records.length).toBe(count);

    for (let i = 0; i < count; i++) {
      const record = machine.get(`tx-concurrent-${i}`);
      expect(record).toBeDefined();
      expect(record!.id).toBe(`tx-concurrent-${i}`);
    }
  });

  it('accepts a SettlementProfile object directly as config.profile', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: 'tx-inline-profile', state: SettlementState.Confirmed });

    const inlineProfile: SettlementProfile = {
      name: 'inline_test',
      facilitatorTimeoutMs: 5_000,
      pollIntervalMs: 2_000,
      maxPollWindowMs: 30_000,
    };

    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: inlineProfile,
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-inline-profile',
          txHash: '0xdead',
          validBefore: 2000000000000,
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

    await middlewarePromise;

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
        const callArgs = pollSpy.mock.calls[0][0];
        expect(callArgs.id).toBe('tx-inline-profile');
        expect(callArgs.profile.name).toBe('inline_test');
      },
      { timeout: 200 },
    );
  });

  it('duplicate settlement registration does not break middleware', async () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-dup', { profileName: 'datacenter', txHash: '0xdead' });

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-dup',
          txHash: '0xdead',
          validBefore: 2000000000000,
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);
    expect(() => middleware(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(2);

    await middlewarePromise;

    const record = machine.get('tx-dup');
    expect(record).toBeDefined();
    expect(record!.state).not.toBe(SettlementState.Unresolved);
  });

  it('creates validBefore from seconds when ctx.validBefore is in seconds', async () => {
    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-seconds',
          txHash: '0xdead',
          validBefore: 1700000000,
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);
    await middlewarePromise;

    const record = machine.get('tx-seconds');
    expect(record).toBeDefined();
    expect(record!.validBefore).toBe(1700000000000);
  });

  it('keeps validBefore as-is when already in milliseconds', async () => {
    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-ms',
          txHash: '0xdead',
          validBefore: 2000000000000,
          timedOut: true,
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);
    await middlewarePromise;

    const record = machine.get('tx-ms');
    expect(record).toBeDefined();
    expect(record!.validBefore).toBe(2000000000000);
  });

  it('generates canonicalKey when payer, payTo, value, nonce are available', async () => {
    const dispatchSpy = vi.fn();
    const machine = createSettlementStateMachine();

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
      pollDispatcher: {
        dispatchPoll: dispatchSpy,
      },
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-canon',
          txHash: '0xdead',
          timedOut: true,
          payer: '0xpayer',
          payTo: '0xpayto',
          value: '100',
          nonce: '1',
        },
      },
    });

    const next = vi.fn();
    const middlewarePromise = middleware(req, res, next);
    await middlewarePromise;

    expect(dispatchSpy).toHaveBeenCalledOnce();
    const dispatchArg = dispatchSpy.mock.calls[0][0];
    expect(dispatchArg.settlementId).toBe('tx-canon');
    expect(dispatchArg.canonicalKey).toBe('0xpayer:0xpayto:100:1');
  });

  describe('terminal state protection', () => {
    it('leaves Confirmed record unchanged on duplicate timeout', async () => {
      const machine = createSettlementStateMachine();
      machine.create('tx-confirmed', {
        profileName: 'datacenter',
        txHash: '0xabc',
      });
      machine.transition('tx-confirmed', SettlementState.Confirmed);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-confirmed',
            txHash: '0xabc',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = machine.get('tx-confirmed');
      expect(record!.state).toBe(SettlementState.Confirmed);
    });

    it('leaves ConfirmedLate record unchanged on duplicate timeout', async () => {
      const machine = createSettlementStateMachine();
      machine.create('tx-late', {
        profileName: 'datacenter',
        txHash: '0xdef',
      });
      machine.transition('tx-late', SettlementState.ConfirmedLate);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-late',
            txHash: '0xdef',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = machine.get('tx-late');
      expect(record!.state).toBe(SettlementState.ConfirmedLate);
    });

    it('leaves FailedOrphaned record unchanged on duplicate timeout', async () => {
      const machine = createSettlementStateMachine();
      machine.create('tx-orphaned', {
        profileName: 'datacenter',
        txHash: '0x999',
      });
      machine.transition('tx-orphaned', SettlementState.FailedOrphaned);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-orphaned',
            txHash: '0x999',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = machine.get('tx-orphaned');
      expect(record!.state).toBe(SettlementState.FailedOrphaned);
    });

    it('upgrades Unresolved (no txHash) to Polling when duplicate has txHash', async () => {
      const pollSpy = vi
        .spyOn(pollerModule, 'pollUntilResolved')
        .mockResolvedValue({ id: 'tx-unresolved-upgrade', state: SettlementState.Confirmed });

      const machine = createSettlementStateMachine();
      machine.create('tx-unresolved-upgrade', {
        profileName: 'datacenter',
      });
      machine.transition('tx-unresolved-upgrade', SettlementState.Unresolved);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-unresolved-upgrade',
            txHash: '0xnewhash',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      await vi.waitFor(
        () => {
          expect(pollSpy).toHaveBeenCalledOnce();
        },
        { timeout: 200 },
      );
    });

    it('leaves Unresolved (with txHash) unchanged when duplicate has txHash', async () => {
      const pollSpy = vi
        .spyOn(pollerModule, 'pollUntilResolved')
        .mockResolvedValue({ id: '', state: SettlementState.Confirmed });

      const machine = createSettlementStateMachine();
      machine.create('tx-unresolved-with-hash', {
        profileName: 'datacenter',
        txHash: '0xoriginal',
      });
      machine.transition('tx-unresolved-with-hash', SettlementState.Unresolved);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-unresolved-with-hash',
            txHash: '0xnewhash',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      await new Promise((r) => setTimeout(r, 50));
      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('leaves Unresolved (no txHash) unchanged when duplicate also has no txHash', async () => {
      const machine = createSettlementStateMachine();
      machine.create('tx-unresolved-nohash', {
        profileName: 'datacenter',
      });
      machine.transition('tx-unresolved-nohash', SettlementState.Unresolved);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-unresolved-nohash',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = machine.get('tx-unresolved-nohash');
      expect(record!.state).toBe(SettlementState.Unresolved);
    });
  });

  describe('dispatcher mode', () => {
    it('dispatches instead of polling in-process', async () => {
      const pollSpy = vi
        .spyOn(pollerModule, 'pollUntilResolved')
        .mockResolvedValue({ id: '', state: SettlementState.Confirmed });
      const dispatchSpy = vi.fn();

      const machine = createSettlementStateMachine();

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
        pollDispatcher: {
          dispatchPoll: dispatchSpy,
        },
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-dispatcher',
            txHash: '0xdead',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      expect(dispatchSpy).toHaveBeenCalledOnce();
      expect(dispatchSpy.mock.calls[0][0].settlementId).toBe('tx-dispatcher');

      const record = machine.get('tx-dispatcher');
      expect(record).toBeDefined();

      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('catches sync dispatch errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dispatchSpy = vi.fn(() => {
        throw new Error('dispatch sync error');
      });

      const machine = createSettlementStateMachine();

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
        pollDispatcher: {
          dispatchPoll: dispatchSpy,
        },
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-sync-error',
            txHash: '0xdead',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      expect(next).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement.dispatcher.error' }),
      );

      consoleSpy.mockRestore();
    });

    it('catches async dispatch rejections', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dispatchSpy = vi.fn(() => {
        return Promise.reject(new Error('dispatch async error'));
      });

      const machine = createSettlementStateMachine();

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: machine,
        pollDispatcher: {
          dispatchPoll: dispatchSpy,
        },
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-async-error',
            txHash: '0xdead',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      await vi.waitFor(
        () => {
          expect(consoleSpy).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'settlement.dispatcher.error' }),
          );
        },
        { timeout: 200 },
      );

      consoleSpy.mockRestore();
    });

    it('throws when pollDispatcher is provided without stateMachine', () => {
      expect(() =>
        createRecoveryMiddleware({
          profile: 'datacenter',
          receiptProvider: fakeReceiptProvider(),
          pollDispatcher: {
            dispatchPoll: vi.fn(),
          },
        }),
      ).toThrow('pollDispatcher requires stateMachine');
    });
  });

  describe('async StateMachine', () => {
    it('works with a Promise-returning StateMachine', async () => {
      const syncMachine = createSettlementStateMachine();
      const asyncMachine = makeAsyncMachine(syncMachine);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: asyncMachine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-async-sm',
            txHash: '0xdead',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = syncMachine.get('tx-async-sm');
      expect(record).toBeDefined();
      expect(record!.state).not.toBe(SettlementState.Unresolved);
    });

    it('handles duplicate registration with async StateMachine', async () => {
      const syncMachine = createSettlementStateMachine();
      syncMachine.create('tx-async-dup', {
        profileName: 'datacenter',
        txHash: '0xabc',
      });
      const asyncMachine = makeAsyncMachine(syncMachine);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: asyncMachine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-async-dup',
            txHash: '0xabc',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = syncMachine.get('tx-async-dup');
      expect(record).toBeDefined();
    });

    it('handles missing txHash with async StateMachine', async () => {
      const syncMachine = createSettlementStateMachine();
      const asyncMachine = makeAsyncMachine(syncMachine);

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: asyncMachine,
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-async-nohash',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      const record = syncMachine.get('tx-async-nohash');
      expect(record).toBeDefined();
      expect(record!.state).toBe(SettlementState.Unresolved);
    });

    it('dispatcher path works with async StateMachine', async () => {
      const syncMachine = createSettlementStateMachine();
      const asyncMachine = makeAsyncMachine(syncMachine);
      const dispatchSpy = vi.fn();

      const middleware = createRecoveryMiddleware({
        profile: 'datacenter',
        receiptProvider: fakeReceiptProvider(),
        stateMachine: asyncMachine,
        pollDispatcher: {
          dispatchPoll: dispatchSpy,
        },
      });

      const req = fakeReq();
      const res = fakeRes({
        locals: {
          x402Settlement: {
            settlementId: 'tx-async-dispatcher',
            txHash: '0xdead',
            timedOut: true,
          },
        },
      });

      const next = vi.fn();
      const middlewarePromise = middleware(req, res, next);
      await middlewarePromise;

      expect(dispatchSpy).toHaveBeenCalledOnce();
      expect(dispatchSpy.mock.calls[0][0].settlementId).toBe('tx-async-dispatcher');
    });
  });
});
