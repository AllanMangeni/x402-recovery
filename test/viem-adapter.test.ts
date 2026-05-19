import { describe, it, expect, vi } from 'vitest';
import { createViemReceiptProvider } from '../src/adapters/viem';
import type { ReceiptProvider, SettlementReceipt } from '../src/types';

interface FakeViemReceipt {
  status: string;
  blockNumber?: bigint;
}

function fakePublicClient(receipt: FakeViemReceipt | null, blockNumber?: bigint) {
  return {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => blockNumber ?? 0n,
  } as any;
}

describe('createViemReceiptProvider', () => {
  it('returns null for missing receipt', async () => {
    const client = fakePublicClient(null);
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).toBeNull();
  });

  it('maps success receipt status', async () => {
    const client = fakePublicClient({ status: 'success', blockNumber: 100n });
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('success');
    expect(result!.blockNumber).toBe(100n);
  });

  it('maps reverted receipt status', async () => {
    const client = fakePublicClient({ status: 'reverted', blockNumber: 200n });
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('reverted');
  });

  it('maps unknown receipt statuses to unknown', async () => {
    const client = fakePublicClient({ status: '0x0', blockNumber: 300n });
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('unknown');
  });

  it('computes confirmations from block numbers', async () => {
    const client = fakePublicClient(
      { status: 'success', blockNumber: 100n },
      105n,
    );
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).not.toBeNull();
    expect(result!.confirmations).toBe(6);
  });

  it('returns undefined confirmations when receipt has no blockNumber', async () => {
    const client = fakePublicClient(
      { status: 'success', blockNumber: undefined },
      100n,
    );
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).not.toBeNull();
    expect(result!.confirmations).toBeUndefined();
  });

  it('returns undefined confirmations when getBlockNumber fails', async () => {
    const client = {
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n }),
      getBlockNumber: async () => { throw new Error('RPC unavailable'); },
    } as any;
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result).not.toBeNull();
    expect(result!.confirmations).toBeUndefined();
  });

  it('computed confirmations is >= 1 for a mined receipt', async () => {
    const client = fakePublicClient(
      { status: 'success', blockNumber: 100n },
      100n,
    );
    const provider = createViemReceiptProvider(client);

    const result = await provider.getTransactionReceipt({ txHash: '0xabc' as `0x${string}` });
    expect(result!.confirmations).toBe(1);
  });
});
