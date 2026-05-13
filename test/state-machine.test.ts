import { describe, it, expect } from 'vitest';
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
});
