import { describe, it, expect } from 'vitest';
import {
  createSettlementStateMachine,
  SettlementState,
  PROFILES,
} from '../src';

describe('SettlementStateMachine', () => {
  it('creates a settlement in pending state with default profile', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-001');

    expect(record.id).toBe('tx-001');
    expect(record.state).toBe(SettlementState.Pending);
    expect(record.profile.name).toBe('datacenter');
    expect(record.txHash).toBeUndefined();
    expect(record.validBefore).toBeUndefined();
  });

  it('creates a settlement with explicit profile and metadata', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-002', {
      profileName: 'east_africa_3g',
      txHash: '0xabc123',
      validBefore: 1700000000,
    });

    expect(record.profile.name).toBe('east_africa_3g');
    expect(record.txHash).toBe('0xabc123');
    expect(record.validBefore).toBe(1700000000);
    expect(record.state).toBe(SettlementState.Pending);
  });

  it('transitions state correctly', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-003');

    const updated = machine.transition('tx-003', SettlementState.Confirmed);
    expect(updated.state).toBe(SettlementState.Confirmed);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it('throws on duplicate creation', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-004');

    expect(() => machine.create('tx-004')).toThrow(
      'Settlement tx-004 already exists',
    );
  });

  it('throws on unknown profile name', () => {
    const machine = createSettlementStateMachine();

    expect(() =>
      machine.create('tx-005', { profileName: 'nonexistent' as any }),
    ).toThrow('Unknown settlement profile: nonexistent');
  });

  it('lists all settlements', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-006');
    machine.create('tx-007', { profileName: 'east_africa_3g' });

    const all = machine.list();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual(['tx-006', 'tx-007']);
  });
});
