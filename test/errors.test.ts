import { describe, it, expect } from 'vitest';
import { RecoveryError, isRecoveryError } from '../src/errors';

describe('RecoveryError', () => {
  it('stores code, statusCode, message, and details', () => {
    const err = new RecoveryError('test_code', 418, 'I am a teapot', { foo: 'bar' });
    expect(err.code).toBe('test_code');
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe('I am a teapot');
    expect(err.details).toEqual({ foo: 'bar' });
  });

  it('serialises to JSON with toJSON()', () => {
    const err = new RecoveryError('json_test', 400, 'Bad request', { field: 'amount' });
    expect(err.toJSON()).toEqual({
      code: 'json_test',
      statusCode: 400,
      message: 'Bad request',
      details: { field: 'amount' },
    });
  });

  it('is recognised by instanceof', () => {
    const err = new RecoveryError('instance', 500, 'Server error');
    expect(err instanceof RecoveryError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('is identified by isRecoveryError()', () => {
    const recoveryErr = new RecoveryError('yes', 400, 'yes');
    const plainErr = new Error('no');
    expect(isRecoveryError(recoveryErr)).toBe(true);
    expect(isRecoveryError(plainErr)).toBe(false);
    expect(isRecoveryError(null)).toBe(false);
    expect(isRecoveryError('string')).toBe(false);
  });

  it('factory helpers produce correct instances', () => {
    const err = new RecoveryError('settlement_not_found', 404, 'Not found', { settlementId: 'x' });
    expect(err.code).toBe('settlement_not_found');
    expect(err.statusCode).toBe(404);
  });

  it('toSafeJSON omits details to avoid leaking sensitive data', () => {
    const err = new RecoveryError('safe_test', 500, 'Server error', { txHash: '0xsecret', payer: '0xalice' });
    expect(err.toSafeJSON()).toEqual({
      code: 'safe_test',
      statusCode: 500,
      message: 'Server error',
    });
    expect(err.toSafeJSON().details).toBeUndefined();
  });
});
