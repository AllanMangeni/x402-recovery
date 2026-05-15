import { SettlementState, ProfileName, PROFILES } from '../types';
import { createSettlementStateMachine } from '../state-machine';
import { pollUntilResolved } from '../poller';
import { createPublicClient, http } from 'viem';

/**
 * Beav3r contract addresses on Base Sepolia.
 * No mainnet deployment exists — this adapter targets testnet only.
 * Do not add a mainnet chain option until Beav3r publishes mainnet addresses.
 */
export const BEAV3R_CONTRACTS = {
  signerRegistry: '0x32638Cd8f41BCd4cb3BBaDb6A6d0CBB3f57bAd7e',
  authorizationVerifier: '0xBc63acbdaD244E0fA6fDBb5c552ED04B7F624900',
} as const;

export interface GuardedPaymentAction {
  type: string;
  amount: string;
  recipient: string;
  metadata?: Record<string, unknown>;
}

export interface GuardedPaymentOptions {
  action: GuardedPaymentAction;
  settlement: {
    settlementId: string;
    simulationId?: string;
    txHash?: string;
    validBefore: number;
    bridgeRef?: string;
  };
  profile: ProfileName;
  beav3rAccountId: string;
}

export interface GuardedPaymentResult {
  authorized: boolean;
  artifact?: unknown;
  settlementState?: SettlementState;
  error?: string;
}

/**
 * Wraps a high-value x402 payment with:
 * 1. Beav3r pre-execution authorization (intent gate — runs before payment fires)
 * 2. x402-recovery post-settlement polling (outcome resolution — runs after payment fires)
 *
 * Use for irreversible operations: payouts, refunds, cross-border transfers,
 * parametric insurance triggers, marketplace split payments.
 *
 * Requires @beav3r/sdk as an optional peer dependency:
 *   npm install @beav3r/sdk
 *
 * Targets Base Sepolia only. Do not use on mainnet.
 */
export async function guardedPayment(
  options: GuardedPaymentOptions,
): Promise<GuardedPaymentResult> {
  const { action, settlement, profile, beav3rAccountId } = options;

  // Step 1: Load Beav3r SDK dynamically — degrades gracefully if not installed
  let BeaV3rSDK: any;
  try {
    BeaV3rSDK = (await import('@beav3r/sdk')).BeaV3rSDK;
  } catch {
    return {
      authorized: false,
      error: 'Beav3r SDK not installed. Run: npm install @beav3r/sdk',
    };
  }

  // Step 2: Request pre-execution authorization from Beav3r
  const beav3r = new BeaV3rSDK();
  let artifact: unknown;

  try {
    artifact = await beav3r.requestAuthorization({
      accountId: beav3rAccountId,
      action: {
        type: action.type,
        payload: {
          amount: action.amount,
          recipient: action.recipient,
          ...action.metadata,
        },
      },
    });
  } catch (err) {
    return {
      authorized: false,
      error: `Beav3r authorization denied: ${String(err)}`,
    };
  }

  // Step 3: txHash absent — mark unresolved, flag for manual review
  if (!settlement.txHash) {
    return {
      authorized: true,
      artifact,
      settlementState: SettlementState.Unresolved,
      error: 'txHash missing from facilitator response. Manual review required.',
    };
  }

  // Step 4: Post-settlement recovery with Africa-aware polling
  const machine = createSettlementStateMachine();
  machine.create(settlement.settlementId, {
    profileName: profile,
    txHash: settlement.txHash,
    validBefore: settlement.validBefore,
  });

  const rpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org';
  const client = createPublicClient({
    transport: http(rpcUrl),
  });

  try {
    await pollUntilResolved({
      client,
      machine,
      id: settlement.settlementId,
      txHash: settlement.txHash as `0x${string}`,
      profile: PROFILES[profile],
    });
  } catch (err) {
    try {
      machine.transition(settlement.settlementId, SettlementState.Unresolved);
    } catch {
      // record may not exist — safe to ignore
    }
    return {
      authorized: true,
      artifact,
      settlementState: SettlementState.Unresolved,
      error: `Poller error: ${String(err)}`,
    };
  }

  const record = machine.get(settlement.settlementId);

  return {
    authorized: true,
    artifact,
    settlementState: record?.state,
  };
}
