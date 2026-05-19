import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response } from 'express';
import { createSettlementStateMachine, StateMachine } from '../src/state-machine';
import { SettlementState, SettlementProfile, ReceiptProvider, normalizeValidBefore } from '../src/types';
import { createRecoveryMiddleware, PollDispatcher } from '../src/middleware';
import * as pollerModule from '../src/poller';
import * as stateMachineModule from '../src/state-machine';

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
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue({ id: 'tx-timedout', state: SettlementState.Confirmed });

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
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
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

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

  it('transitions to Unresolved when timedOut but no txHash', () => {
    const machine = createSettlementStateMachine();
    vi.spyOn(stateMachineModule, 'createSettlementStateMachine').mockReturnValue(machine);

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
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

    const record = machine.get('tx-no-hash');
    expect(record).toBeDefined();
    expect(record!.state).toBe(SettlementState.Unresolved);
  });

  it('transitions to Unresolved and logs when poller rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const machine = createSettlementStateMachine();
    vi.spyOn(stateMachineModule, 'createSettlementStateMachine').mockReturnValue(machine);

    vi.spyOn(pollerModule, 'pollUntilResolved').mockRejectedValue(new Error('RPC timeout'));

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
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
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

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
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue({ id: '', state: SettlementState.Confirmed });

    const machine = createSettlementStateMachine();
    vi.spyOn(stateMachineModule, 'createSettlementStateMachine').mockReturnValue(machine);

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
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
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue({ id: 'tx-inline-profile', state: SettlementState.Confirmed });

    const inlineProfile: SettlementProfile = {
      name: 'inline_test',
      facilitatorTimeoutMs: 5_000,
      pollIntervalMs: 2_000,
      maxPollWindowMs: 30_000,
    };

    const middleware = createRecoveryMiddleware({
      profile: inlineProfile,
      receiptProvider: fakeReceiptProvider(),
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
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();

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

  it('duplicate settlement registration does not break middleware', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-dup', { profileName: 'datacenter' });

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
    expect(() => middleware(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
  });

  it('creates validBefore from seconds when ctx.validBefore is in seconds', () => {
    const machine = createSettlementStateMachine();
    vi.spyOn(stateMachineModule, 'createSettlementStateMachine').mockReturnValue(machine);

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
    middleware(req, res, next);

    const record = machine.get('tx-seconds');
    expect(record).toBeDefined();
    expect(record!.validBefore).toBe(1700000000000);
  });

  it('keeps validBefore as-is when already in milliseconds', () => {
    const machine = createSettlementStateMachine();
    vi.spyOn(stateMachineModule, 'createSettlementStateMachine').mockReturnValue(machine);

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
    middleware(req, res, next);

    const record = machine.get('tx-ms');
    expect(record).toBeDefined();
    expect(record!.validBefore).toBe(2000000000000);
  });

  it('generates canonicalKey when payer, payTo, value, nonce are available', () => {
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue({ id: 'tx-canon', state: SettlementState.Confirmed });

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
    middleware(req, res, next);

    expect(dispatchSpy).toHaveBeenCalledOnce();
    const dispatchArg = dispatchSpy.mock.calls[0][0];
    expect(dispatchArg.settlementId).toBe('tx-canon');
    expect(dispatchArg.canonicalKey).toBe('0xpayer:0xpayto:100:1');
  });

  describe('dispatcher mode', () => {
    it('dispatches instead of polling in-process', async () => {
      const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue({ id: '', state: SettlementState.Confirmed });
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
      middleware(req, res, next);

      expect(dispatchSpy).toHaveBeenCalledOnce();
      expect(dispatchSpy.mock.calls[0][0].settlementId).toBe('tx-dispatcher');

      const record = machine.get('tx-dispatcher');
      expect(record).toBeDefined();

      await new Promise((r) => setTimeout(r, 50));
      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('catches sync dispatch errors', () => {
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
      expect(() => middleware(req, res, next)).not.toThrow();
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
      expect(() => middleware(req, res, next)).not.toThrow();

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
});
