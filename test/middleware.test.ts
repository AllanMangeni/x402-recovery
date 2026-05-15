import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { PublicClient } from 'viem';
import { createSettlementStateMachine } from '../src/state-machine';
import { SettlementState } from '../src/types';
import { createRecoveryMiddleware } from '../src/middleware';
import * as pollerModule from '../src/poller';
import * as stateMachineModule from '../src/state-machine';

function fakeClient(): PublicClient {
  return {
    getTransactionReceipt: async () => ({ status: 'success' }),
  } as unknown as PublicClient;
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
      client: fakeClient(),
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
      client: fakeClient(),
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
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved').mockResolvedValue(undefined);

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      client: fakeClient(),
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-timedout',
          txHash: '0xdead',
          validBefore: 2000000000,
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

  it('transitions to Unresolved and logs when poller rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const machine = createSettlementStateMachine();
    const machineSpy = vi
      .spyOn(stateMachineModule, 'createSettlementStateMachine')
      .mockReturnValue(machine);

    vi.spyOn(pollerModule, 'pollUntilResolved').mockRejectedValue(new Error('RPC timeout'));

    const middleware = createRecoveryMiddleware({
      profile: 'datacenter',
      client: fakeClient(),
    });

    const req = fakeReq();
    const res = fakeRes({
      locals: {
        x402Settlement: {
          settlementId: 'tx-poller-fail',
          txHash: '0xdead',
          validBefore: 2000000000,
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

    machineSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
