import { RecoveryError } from './errors';

export function logError(err: RecoveryError): void {
  console.error({
    event: err.code,
    ...err.toSafeJSON(),
    timestamp: Date.now(),
  });
}
