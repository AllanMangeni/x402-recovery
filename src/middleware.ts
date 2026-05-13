import { Request, Response, NextFunction } from 'express';
import { createSettlementStateMachine } from './state-machine';
import { PROFILES, EnvironmentProfile } from './types';

export interface RecoveryConfig {
  profile: EnvironmentProfile;
  rpcUrl: string;
  bridgeKey?: (req: Request) => string | undefined;
}

export function createRecoveryMiddleware(config: RecoveryConfig) {
  const profile = PROFILES[config.profile];
  const machine = createSettlementStateMachine();

  return (_req: Request, _res: Response, next: NextFunction) => {
    // TODO:
    // - intercept facilitator timeout responses
    // - extract txHash and nonce / id
    // - register in machine with profile, txHash, validBefore
    // - start polling using pollUntilResolved (once implemented)
    next();
  };
}
