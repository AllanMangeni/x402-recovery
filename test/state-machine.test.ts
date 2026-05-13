import { describe, it, expect } from 'vitest';
import {
  createSettlementStateMachine,
  SettlementState,
  PROFILES,
} from '../src';

describe('SettlementStateMachine', () => {
  it('creates a settlement in pending state', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-001');

    expect(record.id).toBe('tx-001');
    expect(record.state).toBe(SettlementState.Pending);
    expect(record.profile.name).toBe('standard');
    expect(record.confirmations).toBe(0);
  });

  it('transitions state correctly', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-002');

    const updated = machine.transition('tx-002', SettlementState.Confirmed);
    expect(updated.state).toBe(SettlementState.Confirmed);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it('throws on duplicate creation', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-003');

    expect(() => machine.create('tx-003')).toThrow(
      'Settlement tx-003 already exists',
    );
  });

  it('lists all settlements', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-004');
    machine.create('tx-005', 'fast');

    const all = machine.list();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual(['tx-004', 'tx-005']);
  });
});
