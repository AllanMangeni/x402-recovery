import { RecoveryError } from './errors';

export function logError(err: RecoveryError): void {
  console.error({
    event: err.code,
    ...err.toJSON(),
    timestamp: Date.now(),
  });
}
