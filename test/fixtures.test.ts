import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecoveryHook } from '../src/hooks';
import * as pollerModule from '../src/poller';

// Canonical x402 v2 payload shapes observed in the wild.
// These fixtures ensure the hook remains compatible with real
// facilitator output even if @x402/core types drift.

const FIXTURE_EXACT = {
  error: new Error('facilitator timeout'),
  paymentPayload: {
    from: '0xADEeaf70E39b2d393092B6B70EFd92162B7704e5',
    to: '0x1111111111111111111111111111111111111111',
    value: '1000000',
    nonce: '0x0000000000000000000000000000000000000000000000000000000000000042',
    validBefore: 1778573803,
    transaction: { hash: '0xabc123def456' },
  },
  requirements: {
    amount: '1000000',
    network: 'base-sepolia',
    payTo: '0x1111111111111111111111111111111111111111',
  },
};

const FIXTURE_BATCH = {
  error: new Error('batch settlement timeout'),
  paymentPayload: {
    from: '0xPayer',
    to: '0xPayTo',
    value: '5000000',
    nonce: '0xdeadbeef',
    deadline: 1778573900,
    transaction: { hash: '0xbatchhash' },
  },
  requirements: {
    amount: '5000000',
    network: 'base-mainnet',
    payTo: '0xPayTo',
  },
};

const FIXTURE_MINIMAL = {
  error: new Error('minimal failure'),
  paymentPayload: {},
  requirements: {},
};

describe('x402 payload fixtures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts canonical exact-settlement payload', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xabc123def456', state: 'confirmed' as any });

    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: {
        getTransactionReceipt: async () => ({ status: 'success', confirmations: 1 }),
      },
    });

    await hook(FIXTURE_EXACT as any);

    await vi.waitFor(() => expect(pollSpy).toHaveBeenCalledOnce(), { timeout: 200 });

    const args = pollSpy.mock.calls[0][0];
    expect(args.txHash).toBe('0xabc123def456');
    expect(args.id).toBe('0xabc123def456');
  });

  it('accepts canonical batch-settlement payload', async () => {
    const pollSpy = vi
      .spyOn(pollerModule, 'pollUntilResolved')
      .mockResolvedValue({ id: '0xbatchhash', state: 'confirmed' as any });

    const hook = createRecoveryHook({
      profile: 'batch',
      receiptProvider: {
        getTransactionReceipt: async () => ({ status: 'success', confirmations: 1 }),
      },
    });

    await hook(FIXTURE_BATCH as any);

    await vi.waitFor(() => expect(pollSpy).toHaveBeenCalledOnce(), { timeout: 200 });

    const args = pollSpy.mock.calls[0][0];
    expect(args.txHash).toBe('0xbatchhash');
  });

  it('handles minimal payload without crashing', async () => {
    const hook = createRecoveryHook({
      profile: 'datacenter',
      receiptProvider: {
        getTransactionReceipt: async () => null,
      },
    });

    await expect(hook(FIXTURE_MINIMAL as any)).resolves.toBeUndefined();
  });
});
