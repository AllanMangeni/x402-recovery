export interface RecoveryErrorDetails {
  [key: string]: unknown;
}

export class RecoveryError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: RecoveryErrorDetails;

  constructor(
    code: string,
    statusCode: number,
    message: string,
    details?: RecoveryErrorDetails,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, RecoveryError.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      details: this.details,
    };
  }

  /**
   * Returns a JSON representation without `details`, suitable for
   * logging to third-party services where tx hashes or payer addresses
   * should not leak.
   */
  toSafeJSON() {
    return {
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
    };
  }
}

export function isRecoveryError(error: unknown): error is RecoveryError {
  return error instanceof RecoveryError;
}
