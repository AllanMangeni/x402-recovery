# x402-recovery

[![npm version](https://img.shields.io/npm/v/x402-recovery)](https://www.npmjs.com/package/x402-recovery)
[![npm downloads](https://img.shields.io/npm/dm/x402-recovery)](https://www.npmjs.com/package/x402-recovery)

Settlement recovery middleware for the [x402](https://x402.org/) payment protocol, built for low-connectivity and mobile-money-adjacent markets.

## Why this exists

x402 separates verify and settle phases to keep latency low. When the facilitator times out but the transaction later confirms on-chain, clients can see a definite failure while the chain shows success. That Two-Phase Gap causes duplicate work, manual recovery, and working capital risk in variable networks. This library closes that gap at the middleware layer without changing on-chain guarantees.

For bridges linking mobile money rails to x402 settlement, idempotency keys link mobile money txids to x402 nonces so either system can independently recover the settlement state after a drop.

## Where this fits

[Amazon Bedrock AgentCore Payments](https://aws.amazon.com/blogs/machine-learning/agents-that-transact-introducing-amazon-bedrock-agentcore-payments-built-with-coinbase-and-stripe/) covers the happy path and managed wallets in preview regions. It does not address African mobile rails or higher facilitator timeouts on 3G. [x402](https://x402.org/) makes the payment primitive portable, and x402-recovery is the recovery layer that keeps resource delivery safe when a facilitator times out and the on-chain outcome is unknown.

## States

| State | Meaning |
|---|---|
| pending | Record created, polling not started |
| polling | RPC polling in progress |
| confirmed | On-chain receipt succeeded within facilitator timeout |
| confirmed_late | On-chain receipt succeeded after facilitator timeout |
| unresolved | Fatal RPC error; manual review needed |
| failed | Transaction reverted or poll window expired |
| failed_orphaned | Poll window expired after validBefore; authorization expired |

## Environment profiles

| Profile | Facilitator timeout | Poll interval | Max poll window |
|---|---:|---:|---:|
| datacenter | 5s | 2s | 30s |
| east_africa | 15s | 5s | 90s |
| west_africa | 15s | 5s | 90s |
| east_africa_mpesa | 20s | 7s | 120s |
| west_africa_momo | 20s | 7s | 120s |

## Installation

```bash
npm install x402-recovery
```

## Usage

### State machine

```ts
import { createSettlementStateMachine, SettlementState } from 'x402-recovery';

const machine = createSettlementStateMachine();

const record = machine.create('tx-001', {
  profileName: 'east_africa',
  txHash: '0xabc...',
  validBefore: Date.now() + 90_000,
});

console.log(record.state); // SettlementState.Pending

machine.transition('tx-001', SettlementState.Confirmed);
```

### Poller

```ts
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { pollUntilResolved, createSettlementStateMachine, PROFILES } from 'x402-recovery';

const rpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

const machine = createSettlementStateMachine();

machine.create('settlement-1', {
  profileName: 'datacenter',
  txHash: '0xdead...',
  validBefore: Date.now() + 30_000,
});

await pollUntilResolved({
  client,
  machine,
  id: 'settlement-1',
  txHash: '0xdead...',
  profile: PROFILES.datacenter,
});

const record = machine.get('settlement-1');
console.log(record?.state);
```

### Express middleware

```ts
import express from 'express';
import { createRecoveryMiddleware } from 'x402-recovery';

const app = express();

app.use(
  createRecoveryMiddleware({
    profile: 'east_africa',
    rpcUrl: process.env.BASE_RPC_URL!,
  }),
);

app.get('/pay', (req, res) => {
  res.locals.x402Settlement = {
    settlementId: req.headers['x-request-id'] as string,
    txHash: '0x...',
    validBefore: Date.now() + 90_000,
    timedOut: true,
  };

  res.status(202).json({ status: 'pending' });
});

app.listen(3000);
```

The middleware reads `res.locals.x402Settlement` after `next()` and starts recovery internally when `timedOut === true`.

### Beav3r pre-execution guard

```ts
import { guardedPayment, PROFILES } from 'x402-recovery';

const result = await guardedPayment({
  action: {
    type: 'payout',
    amount: '1000000',
    recipient: '0xRecipient',
  },
  settlement: {
    settlementId: 'settlement-1',
    txHash: '0xdead...',
    validBefore: Date.now() + 120_000,
  },
  profile: 'west_africa_momo',
  beav3rAccountId: 'your-account-id',
});

console.log(result.authorized);       // true
console.log(result.settlementState);  // SettlementState.Confirmed
```

The Beav3r adapter adds a pre-execution authorization gate before settlement polling. It loads `@beav3r/sdk` dynamically — install it as an optional dependency:

```bash
npm install @beav3r/sdk
```

Targets Base Sepolia only. Do not use on mainnet until Beav3r publishes mainnet addresses.

## Handling missing txHash

Some facilitator responses may omit `txHash`. In that case, the middleware should register the settlement and mark it `unresolved` rather than polling. Recovery needs an on-chain transaction id to continue.

```ts
if (!settlementContext.txHash) {
  machine.create(settlementContext.settlementId, {
    profileName: profile,
    validBefore: settlementContext.validBefore,
  });
  machine.transition(settlementContext.settlementId, SettlementState.Unresolved);
  return;
}
```

## Observability

Emit structured events keyed by `settlementId`:

- `settlement.registered`
- `settlement.poll.started`
- `settlement.poll.result`
- `settlement.final`

Recommended fields:
- `settlementId`
- `profile`
- `txHash` if available
- `validBefore`
- `attempt`
- `receiptStatus`
- `blockNumber`
- `finalState`

Use OpenTelemetry traces so facilitator responses, middleware events, and on-chain receipts can be correlated end to end.

## Reconciliation compatibility

x402-recovery composes with external chain observation tools. The `canonicalKey`
four-tuple `(payer, payTo, value, nonce)` aligns with the x402trace JSONL schema
across all three of its event types:

| x402-recovery field | x402trace event | x402trace field |
|---|---|---|
| `payer` | `exchange.payment` | `payload.authorization.from` |
| `payer` | `chain.transfer` | `from` |
| `payer` | `reconcile.result` | `pending.payer` |
| `payTo` | `exchange.payment` | `payload.authorization.to` |
| `payTo` | `chain.transfer` | `to` |
| `payTo` | `reconcile.result` | `pending.payTo` |
| `value` | `exchange.payment` | `payload.authorization.value` |
| `value` | `chain.transfer` | `value` |
| `value` | `reconcile.result` | `pending.value` |
| `nonce` | `exchange.payment` | `payload.authorization.nonce` |
| `nonce` | `chain.transfer` | `authorizationNonce` |
| `nonce` | `reconcile.result` | `pending.nonce` |

A persistence layer keyed on `canonicalKey(payer, payTo, value, nonce)` can match
records across x402-recovery and x402trace without a secondary join.

**`reconcile.result.kind` → SettlementState:**

| x402trace `kind` | x402-recovery `SettlementState` |
|---|---|
| `settled_on_chain` | `Confirmed` or `ConfirmedLate` (check `validBefore`) |
| `not_settled` | `FailedOrphaned` (watch window exhausted) |
| `value_mismatch` | `FailedOrphaned` (on-chain value diverged from authorization) |
| `recipient_mismatch` | `FailedOrphaned` (on-chain transfer paid wrong address) |

**BigInt / string convention:** x402trace serializes all `uint256` fields
(`value`, `nonce`, `blockNumber`) as strings to preserve precision across
`JSON.parse`. `canonicalKey` expects `value` and `nonce` as strings for the
same reason. Convert with `.toString()` before use — do not pass `BigInt`
values directly.

**Low-connectivity clients:** x402-recovery handles recovery for clients that
can poll. For clients that cannot poll (satellite, intermittent 2G), an external
passive chain reader such as x402trace provides the complementary observation
layer. Both tools key on the same canonical four-tuple.

## Notes and limitations

- In-memory state only.
- Poller runs as fire-and-forget. Long poll windows should move to a job queue.
- Middleware assumes the upstream handler sets `timedOut`.
- `txHash` may be absent. Mark those cases `unresolved` for manual review.
- `settlementId` is safe for in-memory deduplication within a single process. Any persistence layer must key on `canonicalKey(payer, payTo, value, nonce)` to be safe across process restarts and back-to-back executions. Once `validBefore` passes, the EIP-3009 authorization cannot be spent on-chain — records in `FailedOrphaned` state with `validBefore < Date.now()` can be safely archived without a separate TTL mechanism.
- `value` and `nonce` in `SettlementContext` and `canonicalKey` are typed as
  `string`. On-chain `uint256` fields must be converted with `.toString()`
  before use. Passing `BigInt` values directly causes silent key comparison
  failures.
- Horizontal scaling needs an external coordination layer.

## Project structure

```text
src/
  types.ts         SettlementState, SettlementProfile, ProfileName, PROFILES,
                   SettlementContext, TransitionEvent, StateMachineOptions,
                   canonicalKey
  state-machine.ts In-memory state machine with onTransition hook
  poller.ts        viem-based RPC polling loop
  middleware.ts    Express middleware with timedOut trigger
  index.ts         Public API exports
  adapters/
    beav3r.ts      Beav3r pre-execution guard adapter
    index.ts       Adapter re-exports
test/
  state-machine.test.ts
  poller.test.ts
  middleware.test.ts
  beav3r-guard.test.ts
```

## Related reading

- [NDSS 2026 Two-Phase Gap poster](https://www.ndss-symposium.org/wp-content/uploads/ndss26-poster-51.pdf)
- [x402 Foundation discussion](https://github.com/x402-foundation/x402/issues/2294)
- [x402-migration-architecture-example](https://github.com/AllanMangeni/x402-migration-architecture-example)

## Contributing

Small, focused PRs are welcome. Keep changes scoped to docs, adapter examples, or tests.

## License

Apache 2.0

## Author

Allan Mang'eni