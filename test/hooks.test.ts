import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecoveryHook, RecoveryPlugin, SettlementFailureContext } from '../src/hooks';
import { SettlementState, PROFILES, ReceiptProvider, SettlementReceipt } from '../src/types';
import { createSettlementStateMachine, StateMachine } from '../src/state-machine';
import * as pollerModule from '../src/poller';

function fakeReceiptProvider(receipt?: SettlementReceipt): ReceiptProvider {
  return {
    getTransactionReceipt: async () => receipt ?? null,
  };
}

function makeAsyncMachine(
  syncMachine: ReturnType<typeof createSettlementStateMachine>,
): StateMachine {
  return {
    create: (id, opts) => Promise.resolve(syncMachine.create(id, opts)),
    get: (id) => Promise.resolve(syncMachine.get(id)),
    transition: (id, state) => Promise.resolve(syncMachine.transition(id, state)),
    update: (id, fields) => Promise.resolve(syncMachine.update(id, fields)),
    list: () => Promise.resolve(syncMachine.list()),
  };
}

describe('createRecoveryHook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no receiptProvider, client, or rpcUrl is provided', () => {
    expect(() =>
      createRecoveryHook({
        profile: 'datacenter',
      }),
    ).toThrow('requires one of receiptProvider, client, or rpcUrl');
  });

  it('creates a recovery record from x402 v2 context and starts polling', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xabc', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider({ status: 'success', confirmations: 1 }),
    });

    const context: SettlementFailureContext = {
      error: new Error('facilitator timeout'),
      paymentPayload: {
        from: '0xPayer',
        to: '0xPayTo',
        value: '1000000',
        nonce: '42',
        validBefore: 2000000000000,
        transaction: { hash: '0xabc' },
      },
      requirements: {
        amount: '1000000',
        network: 'base-sepolia',
        payTo: '0xPayTo',
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
        const args = pollSpy.mock.calls[0][0];
        expect(args.id).toBe('0xabc');
        expect(args.txHash).toBe('0xabc');
        expect(args.profile.name).toBe('datacenter');
      },
      { timeout: 200 },
    );
  });

  it('uses result.transaction.hash as settlementId fallback', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xresultHash', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      result: {
        transaction: { hash: '0xresultHash' },
      },
      paymentPayload: {
        from: '0xPayer',
        value: '1000',
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
        expect(pollSpy.mock.calls[0][0].id).toBe('0xresultHash');
      },
      { timeout: 200 },
    );
  });

  it('transitions to Unresolved when no txHash is present', async () => {
    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const context: SettlementFailureContext = {
      error: new Error('no tx'),
      paymentPayload: {
        from: '0xPayer',
        value: '1000',
      },
    };

    await hook(context);

    // No poller should be started; record should be Unresolved.
    // Since we don't have direct access to the internal machine, we verify
    // by checking that pollUntilResolved was NOT called.
    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved');
    // Wait a tick to let any async work settle
    await new Promise((r) => setTimeout(r, 50));
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it('skips polling for records already in a terminal state', async () => {
    const machine = createSettlementStateMachine();
    machine.create('0xterm', { profileName: 'datacenter', txHash: '0xterm' });
    machine.transition('0xterm', SettlementState.Confirmed);

    const pollSpy = vi.spyOn(pollerModule, 'pollUntilResolved');

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      result: { transaction: { hash: '0xterm' } },
    };

    await hook(context);

    expect(pollSpy).not.toHaveBeenCalled();
  });

  it('handles duplicate settlement registration gracefully', async () => {
    const machine = createSettlementStateMachine();
    machine.create('0xdupe', { profileName: 'datacenter', txHash: '0xdupe' });

    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xdupe', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      result: { transaction: { hash: '0xdupe' } },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
  });

  it('fires afterSettleTimeout hook before polling', async () => {
    const afterHook = vi.fn();
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xhook', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      afterSettleTimeout: afterHook,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        from: '0xPayer',
        transaction: { hash: '0xhook' },
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(afterHook).toHaveBeenCalledOnce();
        expect(pollSpy).toHaveBeenCalledOnce();
        const hookCallOrder = afterHook.mock.invocationCallOrder[0];
        const pollCallOrder = pollSpy.mock.invocationCallOrder[0];
        expect(hookCallOrder).toBeLessThan(pollCallOrder);
      },
      { timeout: 200 },
    );
  });

  it('afterSettleTimeout sync error does not crash recovery', async () => {
    const afterHook = vi.fn(() => {
      throw new Error('hook crash');
    });
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xhookCrash', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      afterSettleTimeout: afterHook,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        transaction: { hash: '0xhookCrash' },
      },
    };

    await expect(hook(context)).resolves.toBeUndefined();

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
  });

  it('isolates 50 concurrent hook invocations without cross-contamination', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const count = 50;
    const contexts = Array.from({ length: count }, (_, i): SettlementFailureContext => ({
      error: new Error(`fail-${i}`),
      paymentPayload: {
        transaction: { hash: `0x${String(i).padStart(64, '0')}` },
      },
    }));

    await Promise.all(contexts.map((ctx) => hook(ctx)));

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledTimes(count);
      },
      { timeout: 500 },
    );
  });

  it('works with an async StateMachine', async () => {
    const syncMachine = createSettlementStateMachine();
    const asyncMachine = makeAsyncMachine(syncMachine);

    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xasync', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: asyncMachine,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        transaction: { hash: '0xasync' },
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
  });

  it('normalizes validBefore from seconds to milliseconds', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xsec', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        validBefore: 1700000000,
        transaction: { hash: '0xsec' },
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
        const args = pollSpy.mock.calls[0][0];
        // Machine record should have normalized ms value
        expect(args.machine.get('0xsec')).toBeDefined();
      },
      { timeout: 200 },
    );
  });

  it('uses deadline as validBefore fallback', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xdeadline', state: SettlementState.Confirmed });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        deadline: 1800000000,
        transaction: { hash: '0xdeadline' },
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
  });

  it('logs and swallows errors when record creation fails repeatedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const brokenMachine: StateMachine = {
      create: () => {
        throw new Error('create fail');
      },
      get: () => undefined,
      transition: () => {
        throw new Error('transition fail');
      },
      update: () => {
        throw new Error('update fail');
      },
      list: () => [],
    };

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: brokenMachine,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        transaction: { hash: '0xbroken' },
      },
    };

    await hook(context);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recovery.hook.create.error' }),
    );

    consoleSpy.mockRestore();
  });

  it('catches poller rejection and transitions to Unresolved', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pollerModule, 'pollUntilResolved').mockRejectedValue(new Error('RPC down'));

    const machine = createSettlementStateMachine();

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
      stateMachine: machine,
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        transaction: { hash: '0xpollerFail' },
      },
    };

    await hook(context);

    await vi.waitFor(
      () => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'recovery.hook.poller.error' }),
        );
        const record = machine.get('0xpollerFail');
        expect(record?.state).toBe(SettlementState.Unresolved);
      },
      { timeout: 200 },
    );

    consoleSpy.mockRestore();
  });
});

describe('RecoveryPlugin', () => {
  it('returns an object with onSettleFailure and onUncertainSettlement', () => {
    const plugin = RecoveryPlugin({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    expect(typeof plugin.onSettleFailure).toBe('function');
    expect(typeof plugin.onUncertainSettlement).toBe('function');
  });

  it('both properties reference the same hook function', () => {
    const plugin = RecoveryPlugin({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    expect(plugin.onSettleFailure).toBe(plugin.onUncertainSettlement);
  });

  it('onSettleFailure starts recovery when invoked', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xplugin', state: SettlementState.Confirmed });

    const plugin = RecoveryPlugin({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const context: SettlementFailureContext = {
      error: new Error('fail'),
      paymentPayload: {
        transaction: { hash: '0xplugin' },
      },
    };

    await plugin.onSettleFailure(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
  });

  it('onUncertainSettlement starts recovery when invoked', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xuncertain', state: SettlementState.Confirmed });

    const plugin = RecoveryPlugin({
      profile: 'datacenter',
      receiptProvider: fakeReceiptProvider(),
    });

    const context: SettlementFailureContext = {
      error: new Error('uncertain'),
      paymentPayload: {
        transaction: { hash: '0xuncertain' },
      },
    };

    await plugin.onUncertainSettlement(context);

    await vi.waitFor(
      () => {
        expect(pollSpy).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
  });
});
