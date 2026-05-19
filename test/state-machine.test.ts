import { describe, it, expect, vi } from 'vitest';
import {
  createSettlementStateMachine,
  SettlementState,
  PROFILES,
  canonicalKey,
  defineProfile,
  normalizeValidBefore,
  StateMachine,
} from '../src';

describe('SettlementStateMachine', () => {
  it('creates a record with default options', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-1');

    expect(record.id).toBe('tx-1');
    expect(record.state).toBe(SettlementState.Created);
    expect(record.profile.name).toBe('datacenter');
    expect(record.txHash).toBeUndefined();
    expect(record.validBefore).toBeUndefined();
    expect(typeof record.createdAt).toBe('number');
    expect(typeof record.updatedAt).toBe('number');
  });

  it('creates a record with a specific environment profile', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-2', {
      profileName: 'datacenter',
      txHash: '0xabc',
      validBefore: 1700000000000,
    });

    expect(record.profile.name).toBe('datacenter');
    expect(record.txHash).toBe('0xabc');
    expect(record.validBefore).toBe(1700000000000);
  });

  it('creates a record with emerging_markets profile', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-em', { profileName: 'emerging_markets', txHash: '0xabc' });

    expect(record.profile.name).toBe('emerging_markets');
    expect(record.state).toBe(SettlementState.Created);
    expect(record.profile.facilitatorTimeoutMs).toBe(15_000);
    expect(record.profile.maxPollWindowMs).toBe(90_000);
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

  it('throws when transitioning a missing id', () => {
    const machine = createSettlementStateMachine();
    expect(() => machine.transition('nonexistent', SettlementState.Confirmed)).toThrow(
      'Settlement nonexistent not found',
    );
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
    expect(event.from).toBe(SettlementState.Created);
    expect(event.to).toBe(SettlementState.Confirmed);
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('emits txHash, payer, payTo, value, nonce in TransitionEvent when present', () => {
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

  it('onTransition sync error does not cause transition to throw', () => {
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

  it('onTransition async rejection does not cause unhandled rejection', async () => {
    let caughtRejection = false;
    const onUnhandled = () => {
      caughtRejection = true;
    };

    process.on('unhandledRejection', onUnhandled);

    const onTransition = vi.fn(() => {
      return Promise.reject(new Error('async callback explosion'));
    });

    const machine = createSettlementStateMachine({ onTransition });
    machine.create('tx-async-hook');

    machine.transition('tx-async-hook', SettlementState.Polling);

    const record = machine.get('tx-async-hook');
    expect(record!.state).toBe(SettlementState.Polling);
    expect(onTransition).toHaveBeenCalledOnce();

    await new Promise((resolve) => setTimeout(resolve, 50));

    process.removeListener('unhandledRejection', onUnhandled);
    expect(caughtRejection).toBe(false);
  });

  it('works normally when no onTransition is provided', () => {
    const machine = createSettlementStateMachine();
    machine.create('tx-hook-5');

    const updated = machine.transition('tx-hook-5', SettlementState.Failed);

    expect(updated.state).toBe(SettlementState.Failed);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it('list returns all records', () => {
    const machine = createSettlementStateMachine();
    machine.create('a');
    machine.create('b');
    machine.create('c');

    const records = machine.list();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('get returns undefined for unknown id', () => {
    const machine = createSettlementStateMachine();
    expect(machine.get('nonexistent')).toBeUndefined();
  });

  it('canonicalKey produces idempotent output for same four-tuple', () => {
    const a = canonicalKey({ payer: '0xA', payTo: '0xB', value: '100', nonce: '0xN1' });
    const b = canonicalKey({ payer: '0xA', payTo: '0xB', value: '100', nonce: '0xN1' });
    expect(a).toBe(b);
  });

  it('canonicalKey distinguishes same nonce with different payer', () => {
    const a = canonicalKey({ payer: '0xA', payTo: '0xB', value: '100', nonce: '0xN1' });
    const b = canonicalKey({ payer: '0xZ', payTo: '0xB', value: '100', nonce: '0xN1' });
    expect(a).not.toBe(b);
  });

  it('canonicalKey distinguishes same nonce with different value', () => {
    const a = canonicalKey({ payer: '0xA', payTo: '0xB', value: '100', nonce: '0xN1' });
    const b = canonicalKey({ payer: '0xA', payTo: '0xB', value: '200', nonce: '0xN1' });
    expect(a).not.toBe(b);
  });

  it('can drive all seven settlement states', () => {
    const machine = createSettlementStateMachine();
    const id = 'tx-all-states';

    machine.create(id);
    expect(machine.get(id)!.state).toBe(SettlementState.Created);

    machine.transition(id, SettlementState.Polling);
    expect(machine.get(id)!.state).toBe(SettlementState.Polling);

    machine.transition(id, SettlementState.Confirmed);
    expect(machine.get(id)!.state).toBe(SettlementState.Confirmed);

    machine.transition(id, SettlementState.ConfirmedLate);
    expect(machine.get(id)!.state).toBe(SettlementState.ConfirmedLate);

    machine.transition(id, SettlementState.Unresolved);
    expect(machine.get(id)!.state).toBe(SettlementState.Unresolved);

    machine.transition(id, SettlementState.Failed);
    expect(machine.get(id)!.state).toBe(SettlementState.Failed);

    machine.transition(id, SettlementState.FailedOrphaned);
    expect(machine.get(id)!.state).toBe(SettlementState.FailedOrphaned);
  });

  it('async StateMachine adapter works', async () => {
    const syncMachine = createSettlementStateMachine();

    const asyncMachine: StateMachine = {
      create: (id, opts) => syncMachine.create(id, opts),
      get: (id) => syncMachine.get(id),
      transition: (id, state) => syncMachine.transition(id, state),
      list: () => syncMachine.list(),
    };

    const record = await asyncMachine.create('async-1', { profileName: 'datacenter' });
    expect(record.state).toBe(SettlementState.Created);

    const got = await asyncMachine.get('async-1');
    expect(got?.id).toBe('async-1');

    const transitioned = await asyncMachine.transition('async-1', SettlementState.Confirmed);
    expect(transitioned.state).toBe(SettlementState.Confirmed);

    const list = await asyncMachine.list();
    expect(list).toHaveLength(1);
  });
});

describe('defineProfile', () => {
  it('returns the object unchanged when valid', () => {
    const profile = defineProfile({
      name: 'custom_latency',
      facilitatorTimeoutMs: 10_000,
      pollIntervalMs: 3_000,
      maxPollWindowMs: 60_000,
    });

    expect(profile.name).toBe('custom_latency');
    expect(profile.facilitatorTimeoutMs).toBe(10_000);
    expect(profile.pollIntervalMs).toBe(3_000);
    expect(profile.maxPollWindowMs).toBe(60_000);
  });

  it('validates requiredConfirmations > 0', () => {
    expect(() =>
      defineProfile({
        name: 'bad',
        facilitatorTimeoutMs: 10_000,
        pollIntervalMs: 3_000,
        maxPollWindowMs: 60_000,
        requiredConfirmations: 0,
      }),
    ).toThrow('must be greater than 0');
  });

  it('accepts valid requiredConfirmations', () => {
    const profile = defineProfile({
      name: 'high_confirm',
      facilitatorTimeoutMs: 10_000,
      pollIntervalMs: 3_000,
      maxPollWindowMs: 60_000,
      requiredConfirmations: 5,
    });

    expect(profile.requiredConfirmations).toBe(5);
  });

  it('throws when pollIntervalMs >= maxPollWindowMs', () => {
    expect(() =>
      defineProfile({
        name: 'bad',
        facilitatorTimeoutMs: 10_000,
        pollIntervalMs: 50_000,
        maxPollWindowMs: 50_000,
      }),
    ).toThrow('must be less than maxPollWindowMs');
  });

  it('throws when facilitatorTimeoutMs >= maxPollWindowMs', () => {
    expect(() =>
      defineProfile({
        name: 'bad',
        facilitatorTimeoutMs: 60_000,
        pollIntervalMs: 3_000,
        maxPollWindowMs: 60_000,
      }),
    ).toThrow('must be less than maxPollWindowMs');
  });

  it('throws when any timing value is <= 0', () => {
    expect(() =>
      defineProfile({
        name: 'bad',
        facilitatorTimeoutMs: 0,
        pollIntervalMs: 3_000,
        maxPollWindowMs: 60_000,
      }),
    ).toThrow('must be greater than 0');
  });

  it('machine.create accepts a direct SettlementProfile object', () => {
    const machine = createSettlementStateMachine();
    const record = machine.create('tx-direct-profile', {
      profile: {
        name: 'direct_fiber',
        facilitatorTimeoutMs: 3_000,
        pollIntervalMs: 1_000,
        maxPollWindowMs: 15_000,
      },
      txHash: '0xprofiletest',
    });

    expect(record.profile.name).toBe('direct_fiber');
    expect(record.txHash).toBe('0xprofiletest');
    expect(record.state).toBe(SettlementState.Created);
  });
});

describe('PROFILES', () => {
  it('has datacenter built-in', () => {
    expect(PROFILES.datacenter).toBeDefined();
    expect(PROFILES.datacenter.facilitatorTimeoutMs).toBe(5_000);
    expect(PROFILES.datacenter.requiredConfirmations).toBe(1);
  });

  it('has emerging_markets built-in', () => {
    expect(PROFILES.emerging_markets).toBeDefined();
    expect(PROFILES.emerging_markets.facilitatorTimeoutMs).toBe(15_000);
    expect(PROFILES.emerging_markets.maxPollWindowMs).toBe(90_000);
    expect(PROFILES.emerging_markets.requiredConfirmations).toBe(1);
  });

  it('does not have removed region-specific profiles', () => {
    expect((PROFILES as Record<string, unknown>).east_africa).toBeUndefined();
    expect((PROFILES as Record<string, unknown>).west_africa).toBeUndefined();
    expect((PROFILES as Record<string, unknown>).east_africa_mpesa).toBeUndefined();
    expect((PROFILES as Record<string, unknown>).west_africa_momo).toBeUndefined();
  });
});

describe('normalizeValidBefore', () => {
  it('converts seconds to milliseconds', () => {
    expect(normalizeValidBefore(1700000000)).toBe(1700000000000);
    expect(normalizeValidBefore('1700000000')).toBe(1700000000000);
    expect(normalizeValidBefore(BigInt(1700000000))).toBe(1700000000000);
  });

  it('leaves milliseconds as-is', () => {
    expect(normalizeValidBefore(1700000000000)).toBe(1700000000000);
    expect(normalizeValidBefore('1700000000000')).toBe(1700000000000);
    expect(normalizeValidBefore(BigInt(1700000000000))).toBe(1700000000000);
  });

  it('throws on zero or negative input', () => {
    expect(() => normalizeValidBefore(0)).toThrow('expected positive number');
    expect(() => normalizeValidBefore(-1)).toThrow('expected positive number');
  });

  it('throws on invalid string input', () => {
    expect(() => normalizeValidBefore('invalid')).toThrow('expected positive number');
  });
});
