# x402-recovery

[![npm version](https://img.shields.io/npm/v/x402-recovery)](https://www.npmjs.com/package/x402-recovery)
[![npm downloads](https://img.shields.io/npm/dm/x402-recovery)](https://www.npmjs.com/package/x402-recovery)

Settlement recovery middleware for the [x402](https://x402.org/) payment protocol, built for low-connectivity and mobile-money-adjacent markets.

## Why this exists

x402 separates verify and settle phases to keep latency low. When a facilitator
times out but the transaction later confirms on-chain, clients see a definite
failure while the chain shows success. This library closes that gap at the
middleware layer without changing on-chain guarantees.

For mobile-money bridges, `bridgeRef` links a mobile money txid to the x402
nonce so either system can recover settlement state independently after a
network drop.

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

For clients that cannot poll (satellite, intermittent 2G), x402trace provides
the passive observation layer. Both tools key on the same canonical four-tuple.

## Notes and limitations

- State is in-memory. Long poll windows should use a job queue.
- `settlementId` is safe for in-process deduplication only. Persistence layers
  must key on `canonicalKey(payer, payTo, value, nonce)`.
- `value` and `nonce` are typed as `string`. Convert on-chain `uint256` fields
  with `.toString()` before use — `BigInt` values cause silent key mismatches.
- Records in `FailedOrphaned` with `validBefore < Date.now()` can be archived
  without a separate TTL. The EIP-3009 authorisation cannot be spent past
  `validBefore`.
- Horizontal scaling requires external coordination.
- `txHash` may be absent from facilitator responses. The middleware marks those
  records `Unresolved`.

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