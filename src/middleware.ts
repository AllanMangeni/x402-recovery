import { Request, Response, NextFunction } from 'express';
import { PublicClient, createPublicClient, http } from 'viem';
import { createSettlementStateMachine } from './state-machine';
import { pollUntilResolved } from './poller';
import { PROFILES, EnvironmentProfile, SettlementContext } from './types';

declare global {
  namespace Express {
    interface Locals {
      x402Settlement?: SettlementContext;
    }
  }
}

export interface RecoveryConfig {
  profile: EnvironmentProfile;
  rpcUrl?: string;
  client?: PublicClient;
  bridgeKey?: (req: Request) => string | undefined;
}

/**
 * Creates an Express middleware that detects x402 facilitator-timeout responses
 * and initiates an on-chain settlement recovery poll.
 *
 * Contract:
 * - Upstream handlers MUST attach `res.locals.x402Settlement` with
 *   `settlementId`, `txHash`, `timedOut: true`, and optionally `validBefore`.
 * - The middleware reads `res.locals.x402Settlement` after `next()` completes.
 * - When `timedOut` is true, the middleware registers the settlement in the
 *   in-memory state machine and calls `pollUntilResolved` as a fire-and-forget
 *   async branch (errors are swallowed to avoid double-response).
 *
 * Production TODOs:
 * - Replace in-memory machine with a persistent store.
 * - Add structured logging / telemetry for the fire-and-forget branch.
 * - Optionally use `bridgeKey` to map requests to settlement ids.
 *
 * Viem client wiring:
 * ```ts
 * import { baseSepolia } from 'viem/chains';
 * const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
 * ```
 * When `config.client` is provided (e.g. for testing), it is used directly.
 * Otherwise a client is created from `config.rpcUrl` without a hardcoded chain,
 * so the caller controls the RPC endpoint.
 */
export function createRecoveryMiddleware(config: RecoveryConfig) {
  const profile = PROFILES[config.profile];
  const machine = createSettlementStateMachine();

  const client: PublicClient =
    config.client ??
    (config.rpcUrl
      ? createPublicClient({
          transport: http(config.rpcUrl),
        })
      : (() => {
          throw new Error(
            'RecoveryConfig requires either rpcUrl or client',
          );
        })());

  return (_req: Request, res: Response, next: NextFunction) => {
    next();

    const ctx = res.locals?.x402Settlement;
    if (!ctx?.timedOut) {
      return;
    }

    const { settlementId, txHash, validBefore } = ctx;
    machine.create(settlementId, {
      profileName: config.profile,
      txHash: txHash as `0x${string}`,
      validBefore,
    });

    pollUntilResolved({
      client,
      machine,
      id: settlementId,
      txHash: txHash as `0x${string}`,
      profile,
    }).catch(() => {
      // Silently swallow — middleware must not crash the request pipeline.
    });
  };
}
