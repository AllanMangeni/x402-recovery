# x402-recovery

[![npm version](https://img.shields.io/npm/v/x402-recovery)](https://www.npmjs.com/package/x402-recovery)
[![npm downloads](https://img.shields.io/npm/dm/x402-recovery)](https://www.npmjs.com/package/x402-recovery)

Late settlement recovery for x402 facilitator timeouts.

## What this solves

x402 separates verify and settle phases to keep latency low. When a facilitator
times out or reports an uncertain failure, but the chain later confirms success,
clients see a definite failure while the chain shows success.

x402-recovery tracks that gap safely — the facilitator says timeout, the chain
may later say success, and this package closes the loop.

## What this does NOT solve

This is not:

- A full settlement indexer
- A facilitator dedup cache
- A queue system or job framework
- A database persistence layer
- A replacement for upstream x402 settlement verification

## States

| State | Meaning |
|---|---|
| created | Recovery record exists, polling not yet started |
| polling | Recovery is actively checking chain truth |
| confirmed | Chain confirmed within facilitator timeout |
| confirmed_late | Chain confirmed after facilitator timeout |
| unresolved | Recovery cannot safely classify the result |
| failed | Transaction reverted or recovery window ended |
| failed_orphaned | Recovery window ended after validBefore; authorization expired |

`ConfirmedLate` is distinct from `Confirmed`. That distinction is the key
product value — it tells you the settlement succeeded, but later than expected.

## Environment profiles

| Profile | Facilitator timeout | Poll interval | Max poll window | Confirmations |
|---|---:|---:|---:|---:|
| datacenter | 5s | 2s | 30s | 1 |
| emerging_markets | 15s | 5s | 90s | 1 |

Custom profiles are created with `defineProfile`:

```ts
import { defineProfile } from 'x402-recovery';

const mobileMoneyProfile = defineProfile({
  name: 'mobile_money',
  facilitatorTimeoutMs: 20_000,
  pollIntervalMs: 7_000,
  maxPollWindowMs: 120_000,
  requiredConfirmations: 1,
});
```

## Installation

```bash
npm install x402-recovery
```

## `validBefore` unit convention

`validBefore` is stored internally as Unix milliseconds.

If your upstream value is EIP-3009 Unix seconds, convert it before passing to
x402-recovery:

```ts
import { normalizeValidBefore } from 'x402-recovery';

const validBeforeMs = normalizeValidBefore(contractValidBefore);
```

Never compare `Date.now()` directly against a seconds-based timestamp. The
`normalizeValidBefore` helper detects the unit and normalizes accordingly.

## Settlement identity

Two identity layers:

### `settlementId`

Local record ID. Useful for in-process state lookup, logs, and job IDs.

### `canonicalKey(payer, payTo, value, nonce)`

Durable payment identity. Required for persistent stores, retries, dispatcher
jobs, and idempotency.

```ts
import { canonicalKey } from 'x402-recovery';

const key = canonicalKey({
  payer: '0xSender',
  payTo: '0xRecipient',
  value: '1000000000000000000',  // 1 ETH as decimal string
  nonce: '42',
});
// => "0xSender:0xRecipient:1000000000000000000:42"
```

Rules:

- Persistent stores must key records by `canonicalKey`
- Dispatcher jobs must include `canonicalKey`
- Middleware must not rely on `settlementId` alone for deduplication
- `value` and `nonce` are strings by design — convert uint256 values upstream

## Usage

### State machine

```ts
import { createSettlementStateMachine, SettlementState } from 'x402-recovery';

const machine = createSettlementStateMachine();

const record = machine.create('tx-001', {
  profileName: 'emerging_markets',
  txHash: '0xabc...',
  validBefore: Date.now() + 90_000,
});

console.log(record.state); // SettlementState.Created

machine.transition('tx-001', SettlementState.Confirmed);
```

### Poller

```ts
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  pollUntilResolved,
  createSettlementStateMachine,
  createViemReceiptProvider,
  PROFILES,
} from 'x402-recovery';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_RPC_URL),
});

const receiptProvider = createViemReceiptProvider(client);
const machine = createSettlementStateMachine();

machine.create('settlement-1', {
  profileName: 'datacenter',
  txHash: '0xdead...',
  validBefore: Date.now() + 30_000,
});

const result = await pollUntilResolved({
  machine,
  receiptProvider,
  id: 'settlement-1',
  txHash: '0xdead...',
  profile: PROFILES.datacenter,
});

console.log(result.state);
```

### Express middleware

```ts
import express from 'express';
import { createRecoveryMiddleware } from 'x402-recovery';

const app = express();

app.use(
  createRecoveryMiddleware({
    profile: 'emerging_markets',
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

### Custom ReceiptProvider

```ts
import type { ReceiptProvider } from 'x402-recovery';

function createWsReceiptProvider(wsUrl: string): ReceiptProvider {
  return {
    async getTransactionReceipt({ txHash }) {
      const resp = await fetch(`${wsUrl}/tx/${txHash}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return {
        status: data.status === 1 ? 'success' : data.status === 0 ? 'reverted' : 'unknown',
        blockNumber: BigInt(data.blockNumber),
        confirmations: data.confirmations,
      };
    },
  };
}
```

### Custom PollDispatcher

```ts
import type { PollDispatcher } from 'x402-recovery';

const dispatcher: PollDispatcher = {
  dispatchPoll(input) {
    // Enqueue to your own job queue, database, or message broker
    settlementQueue.add('recovery', input);
  },
};

const middleware = createRecoveryMiddleware({
  profile: 'datacenter',
  rpcUrl: process.env.BASE_RPC_URL,
  stateMachine: sharedStateMachine,
  pollDispatcher: dispatcher,
});
```

Dispatcher mode requires a shared `stateMachine`. An error is thrown at
middleware creation if `pollDispatcher` is provided without `stateMachine`.

### Custom StateMachine

```ts
import type { StateMachine, SettlementRecord } from 'x402-recovery';

class RedisStateMachine implements StateMachine {
  async create(id: string, opts?) { /* persist to Redis */ }
  async get(id: string) { /* read from Redis */ }
  async transition(id: string, newState: SettlementState) { /* persist in Redis */ }
  async list() { /* scan Redis */ }
}
```

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
  profile: 'emerging_markets',
  beav3rAccountId: 'your-account-id',
});

console.log(result.authorized);       // true
console.log(result.settlementState);  // SettlementState.Confirmed
```

The Beav3r adapter targets Base Sepolia only. Install it as an optional
dependency:

```bash
npm install @beav3r/sdk
```

## Reconciliation compatibility

The `canonicalKey` four-tuple `(payer, payTo, value, nonce)` aligns with the
[x402trace](https://github.com/fardinvahdat/x402trace) JSONL schema:

| x402-recovery | x402trace event | field |
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

`reconcile.result.kind` maps to `SettlementState` as follows:

| kind | SettlementState |
|---|---|
| `settled_on_chain` | `Confirmed` or `ConfirmedLate` |
| `not_settled` | `FailedOrphaned` |
| `value_mismatch` | `FailedOrphaned` |
| `recipient_mismatch` | `FailedOrphaned` |

## Production limitations

The default state machine is in-memory and per-process. It is not durable.

If the process restarts, in-flight polling is lost.

For production reliability, provide a persistent `StateMachine` implementation.

For horizontal scaling, all web workers and poll workers must share the same
`StateMachine`.

Dispatcher mode requires shared state. The package does not provide a queue.

x402-recovery treats `validBefore` as the recovery TTL.

By default, confirmation behavior depends on `requiredConfirmations`, which
defaults to 1.

A successful receipt with 1 confirmation may be too weak for high-value
transfers. Increase `requiredConfirmations` for those flows.

If the facilitator response has no `txHash`, x402-recovery records the
settlement as `Unresolved` and does not poll.

`value` and `nonce` are strings by design. Convert on-chain uint256 values to
strings upstream.

`canonicalKey(payer, payTo, value, nonce)` is the durable identity for retries
and persistence.

## Project structure

```text
src/
  types.ts         SettlementState, SettlementProfile, ProfileName, PROFILES,
                   canonicalKey, defineProfile, normalizeValidBefore,
                   ReceiptProvider, SettlementReceipt
  state-machine.ts In-memory state machine (async-capable interface)
  poller.ts        ReceiptProvider-based polling loop
  middleware.ts    Express middleware with dispatcher support
  index.ts         Public API exports
  adapters/
    viem.ts        Viem receipt provider adapter
    beav3r.ts      Beav3r pre-execution guard adapter
    index.ts       Adapter re-exports
test/
  state-machine.test.ts
  poller.test.ts
  middleware.test.ts
  beav3r-guard.test.ts
```

## Migration from v0.1.x

### Profile names changed

Region-specific built-in profiles (`east_africa`, `west_africa`,
`east_africa_mpesa`, `west_africa_momo`) have been removed from exported
`PROFILES`.

Replace with custom `defineProfile(...)` calls:

```ts
const eastAfricaMpesaLike = defineProfile({
  name: 'east_africa_mpesa_like',
  facilitatorTimeoutMs: 20_000,
  pollIntervalMs: 7_000,
  maxPollWindowMs: 120_000,
  requiredConfirmations: 1,
});
```

### SettlementState.Pending renamed to SettlementState.Created

Update any code that references `SettlementState.Pending` to
`SettlementState.Created`.

### Poller now uses ReceiptProvider

`pollUntilResolved` no longer accepts `client: PublicClient`. Pass a
`ReceiptProvider` instead:

```ts
import { createViemReceiptProvider } from 'x402-recovery';
const receiptProvider = createViemReceiptProvider(client);
```

### Dispatcher requires shared stateMachine

If you use `pollDispatcher`, you must also provide `stateMachine`. An error is
thrown at middleware creation otherwise.

### validBefore unit convention

`validBefore` is now normalized to Unix milliseconds internally. Use
`normalizeValidBefore` if your values come from EIP-3009 seconds.

## Related reading

- [NDSS 2026 Two-Phase Gap poster](https://www.ndss-symposium.org/wp-content/uploads/ndss26-poster-51.pdf)
- [x402 Foundation discussion](https://github.com/x402-foundation/x402/issues/2294)
- [x402-migration-architecture-example](https://github.com/AllanMangeni/x402-migration-architecture-example)

## Contributing

Small, focused PRs are welcome. Keep changes scoped to docs, adapter examples,
or tests.

## License

Apache 2.0

## Author

Allan Mang'eni
