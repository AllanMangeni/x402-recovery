import { describe, it, expect, vi } from 'vitest';
import {
  createSettlementStateMachine,
  SettlementState,
  PROFILES,
} from '../src';

describe('SettlementStateMachine', () => {
  it('creates a record with default options', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-1');

    expect(record.id).toBe('tx-1');
    expect(record.state).toBe(SettlementState.Pending);
    expect(record.profile.name).toBe('datacenter');
    expect(record.txHash).toBeUndefined();
    expect(record.validBefore).toBeUndefined();
    expect(typeof record.createdAt).toBe('number');
    expect(typeof record.updatedAt).toBe('number');
  });

  it('creates a record with a specific environment profile', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-2', {
      profileName: 'east_africa_3g',
      txHash: '0xabc',
      validBefore: 1700000000,
    });

    expect(record.profile.name).toBe('east_africa_3g');
    expect(record.txHash).toBe('0xabc');
    expect(record.validBefore).toBe(1700000000);
  });

  it('transitions states correctly', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-3');

    const updated = machine.transition('tx-3', SettlementState.Unresolved);
    expect(updated.state).toBe(SettlementState.Unresolved);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it('throws on duplicate id', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-4');

    expect(() => machine.create('tx-4')).toThrow(
      'Settlement tx-4 already exists',
    );
  });

  it('throws on unknown profile name', () => {
    const machine = createSettlementStateMachine();

    expect(() =>
      machine.create('tx-5', { profileName: 'unknown_profile' as any }),
    ).toThrow('Unknown settlement profile: unknown_profile');
  });

  it('creates a record with east_africa_mpesa profile', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-mpesa', { profileName: 'east_africa_mpesa', txHash: '0xabc' });

    expect(record.profile.name).toBe('east_africa_mpesa');
    expect(record.state).toBe(SettlementState.Pending);
  });

  it('creates a record with west_africa_momo profile', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-momo', { profileName: 'west_africa_momo', txHash: '0xdef' });

    expect(record.profile.name).toBe('west_africa_momo');
    expect(record.state).toBe(SettlementState.Pending);
  });

  it('calls onTransition on every state transition', () => {
    const onTransition = vi.fn();
    const machine = createSettlementStateMachine({ onTransition });
    machine.create('tx-hook-1');

    machine.transition('tx-hook-1', SettlementState.Polling);
    machine.transition('tx-hook-1', SettlementState.Confirmed);

    expect(onTransition).toHaveBeenCalledTimes(2);
  });

  it('emits correct from, to, and timestamp in TransitionEvent', () => {
    const onTransition = vi.fn();
    const machine = createSettlementStateMachine({ onTransition });
    machine.create('tx-hook-2');
    const before = Date.now();

    machine.transition('tx-hook-2', SettlementState.Confirmed);

    const event = onTransition.mock.calls[0][0];
    expect(event.settlementId).toBe('tx-hook-2');
    expect(event.from).toBe(SettlementState.Pending);
    expect(event.to).toBe(SettlementState.Confirmed);
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('emits EIP-3009 fields in TransitionEvent when present on record', () => {
    const onTransition = vi.fn();
    const machine = createSettlementStateMachine({ onTransition });
    machine.create('tx-hook-3', {
      txHash: '0xabc123',
      payer: '0xpayer',
      payTo: '0xpayto',
      value: '1000000',
      nonce: '0xnonce001',
    });

    machine.transition('tx-hook-3', SettlementState.Confirmed);

    const event = onTransition.mock.calls[0][0];
    expect(event.txHash).toBe('0xabc123');
    expect(event.payer).toBe('0xpayer');
    expect(event.payTo).toBe('0xpayto');
    expect(event.value).toBe('1000000');
    expect(event.nonce).toBe('0xnonce001');
  });

  it('onTransition error does not cause machine.transition to throw', () => {
    const onTransition = vi.fn(() => {
      throw new Error('callback explosion');
    });
    const machine = createSettlementStateMachine({ onTransition });
    machine.create('tx-hook-4');

    expect(() => {
      machine.transition('tx-hook-4', SettlementState.Unresolved);
    }).not.toThrow();

    const record = machine.get('tx-hook-4');
    expect(record!.state).toBe(SettlementState.Unresolved);
    expect(onTransition).toHaveBeenCalledOnce();
  });

  it('works normally when no onTransition is provided', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-hook-5');

    const updated = machine.transition('tx-hook-5', SettlementState.Failed);

    expect(updated.state).toBe(SettlementState.Failed);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });
});
