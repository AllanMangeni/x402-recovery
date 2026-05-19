import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettlementState } from '../src/types';
import { guardedPayment } from '../src/adapters/beav3r';
import * as pollerModule from '../src/poller';

function baseSettlement() {
  return {
    settlementId: 'settlement-test-1',
    txHash: '0xdeadfeeddeadfeeddeadfeeddeadfeeddeadfeeddeadfeeddeadfeeddeadfeed',
    validBefore: Date.now() + 300_000,
  };
}

function baseAction() {
  return { type: 'payment', amount: '1000000', recipient: '0xRecipient' };
}

describe('guardedPayment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns authorized: false when SDK is not installed', async () => {
    vi.doMock('@beav3r/sdk', () => {
      throw new Error('Cannot find module');
    });

    const result = await guardedPayment({
      action: baseAction(),
      settlement: baseSettlement(),
      profile: 'datacenter',
      beav3rAccountId: 'test-account',
    });

    expect(result.authorized).toBe(false);
    expect(result.error).toContain('npm install @beav3r/sdk');
  });

  it('returns authorized: false when authorization is denied', async () => {
    vi.doMock('@beav3r/sdk', () => {
      class MockBeaV3rSDK {
        requestAuthorization = vi.fn().mockRejectedValue(new Error('Authorization rejected'));
      }
      return { BeaV3rSDK: MockBeaV3rSDK };
    });

    const result = await guardedPayment({
      action: baseAction(),
      settlement: baseSettlement(),
      profile: 'datacenter',
      beav3rAccountId: 'test-account',
    });

    expect(result.authorized).toBe(false);
    expect(result.error).toContain('authorization denied');
  });

  it('returns Unresolved when txHash is missing', async () => {
    vi.doMock('@beav3r/sdk', () => {
      class MockBeaV3rSDK {
        requestAuthorization = vi.fn().mockResolvedValue({ sig: '0xmocksig' });
      }
      return { BeaV3rSDK: MockBeaV3rSDK };
    });

    const result = await guardedPayment({
      action: baseAction(),
      settlement: {
        settlementId: 'settlement-no-hash',
        validBefore: Date.now() + 300_000,
      },
      profile: 'datacenter',
      beav3rAccountId: 'test-account',
    });

    expect(result.authorized).toBe(true);
    expect(result.settlementState).toBe(SettlementState.Unresolved);
    expect(result.error).toContain('Manual review');
  });

  it('returns Confirmed when poller resolves successfully', async () => {
    vi.doMock('@beav3r/sdk', () => {
      class MockBeaV3rSDK {
        requestAuthorization = vi.fn().mockResolvedValue({ sig: '0xmocksig' });
      }
      return { BeaV3rSDK: MockBeaV3rSDK };
    });

    vi.doMock('viem', () => ({
      createPublicClient: vi.fn(() => ({
        getTransactionReceipt: async () => ({ status: 'success' }),
      })),
      http: vi.fn(() => ({})),
    }));

    vi.spyOn(pollerModule, 'pollUntilResolved').mockImplementation(async ({ machine, id }) => {
      machine.transition(id, SettlementState.Confirmed);
      return { id, state: SettlementState.Confirmed };
    });

    const result = await guardedPayment({
      action: baseAction(),
      settlement: baseSettlement(),
      profile: 'datacenter',
      beav3rAccountId: 'test-account',
    });

    expect(result.authorized).toBe(true);
    expect(result.settlementState).toBe(SettlementState.Confirmed);
  });

  it('returns Unresolved when poller throws', async () => {
    vi.doMock('@beav3r/sdk', () => {
      class MockBeaV3rSDK {
        requestAuthorization = vi.fn().mockResolvedValue({ sig: '0xmocksig' });
      }
      return { BeaV3rSDK: MockBeaV3rSDK };
    });

    vi.doMock('viem', () => ({
      createPublicClient: vi.fn(() => ({
        getTransactionReceipt: async () => ({ status: 'success' }),
      })),
      http: vi.fn(() => ({})),
    }));

    vi.spyOn(pollerModule, 'pollUntilResolved').mockImplementation(async () => {
      throw new Error('RPC down');
    });

    const result = await guardedPayment({
      action: baseAction(),
      settlement: baseSettlement(),
      profile: 'datacenter',
      beav3rAccountId: 'test-account',
    });

    expect(result.authorized).toBe(true);
    expect(result.settlementState).toBe(SettlementState.Unresolved);
    expect(result.error).toContain('Poller error');
  });
});
