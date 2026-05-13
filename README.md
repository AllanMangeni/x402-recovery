# x402-recovery

Settlement recovery middleware for the [x402](https://x402.org) payment protocol.

## The Problem: x402 Two-Phase Gap

x402 payments involve two phases:
1. A **facilitator** processes the payment off-chain and provides an immediate timeout response.
2. **On-chain settlement** happens asynchronously on Base or Base Sepolia.

If the facilitator gives a timeout response but the transaction later settles on-chain, the payment must still be recognised. This library closes that recovery gap by polling the blockchain for the transaction outcome and updating a state machine that upstream services can observe.

## Settlement States

The in-memory state machine tracks seven states:

| State               | Meaning                                                      |
|---------------------|--------------------------------------------------------------|
| `pending`           | Record created, polling not yet started                      |
| `polling`           | RPC polling is in progress                                   |
| `confirmed`         | On-chain receipt succeeded within the facilitator timeout    |
| `confirmed_late`    | On-chain receipt succeeded after the facilitator timeout     |
| `unresolved`        | Fatal RPC error — manual intervention required               |
| `failed`            | Transaction reverted or poll window expired                  |
| `failed_orphaned`   | Poll window expired after `validBefore` — settlement expired |

## Environment Profiles

Three environment profiles adapt timeout, poll interval, and poll window to expected network conditions:

| Profile           | Facilitator timeout | Poll interval | Max poll window |
|-------------------|---------------------|---------------|-----------------|
| `datacenter`      | 5 s                 | 2 s           | 30 s            |
| `east_africa_3g`  | 15 s                | 5 s           | 90 s            |
| `west_africa_3g`  | 15 s                | 5 s           | 90 s            |

## Implementation

- **In-memory state machine** (`src/state-machine.ts`) — thread-safe map of settlement records with create/transition/get/list operations.
- **viem-based poller** (`src/poller.ts`) — calls `getTransactionReceipt` on a `PublicClient`, maps statuses to states, and accepts an injectable `now()` function for deterministic testing.
- **Express middleware** (`src/middleware.ts`) — detects `res.locals.x402Settlement.timedOut === true` after upstream handlers complete and kicks off the poller as a fire-and-forget async branch.

## Installation

```bash
npm install x402-recovery
```

## Usage

### 1. State machine (standalone)

```ts
import { createSettlementStateMachine, SettlementState } from 'x402-recovery';

const machine = createSettlementStateMachine();

const record = machine.create('tx-001', {
  profileName: 'east_africa_3g',
  txHash: '0xabc...',
  validBefore: 1700000000,
});

console.log(record.state); // SettlementState.Pending

machine.transition('tx-001', SettlementState.Confirmed);
```

### 2. Poller (standalone)

```ts
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { pollUntilResolved, createSettlementStateMachine, PROFILES } from 'x402-recovery';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http('https://sepolia.base.org'),
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
console.log(record?.state); // Confirmed | ConfirmedLate | Failed | ...
```

### 3. Express middleware

The middleware relies on an **upstream handler contract**: after processing a request, the handler attaches settlement details to `res.locals.x402Settlement`. When `timedOut` is `true`, the middleware registers the record and starts polling.

```ts
import express from 'express';
import { createRecoveryMiddleware } from 'x402-recovery';

const app = express();

const recovery = createRecoveryMiddleware({
  profile: 'east_africa_3g',
  rpcUrl: process.env.BASE_RPC_URL!,
});

app.use(recovery);

app.get('/pay', (req, res) => {
  // Facilitator gave a timeout response, but the transaction was submitted.
  // Attach settlement context so the recovery middleware picks it up.
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

#### Viem client wiring

The middleware creates a `PublicClient` from `config.rpcUrl` at construction time. For testability, pass a pre-built `client`:

```ts
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const client = createPublicClient({
  chain: baseSepolia,
  transport: http('https://sepolia.base.org'),
});

const middleware = createRecoveryMiddleware({
  profile: 'datacenter',
  client, // used instead of rpcUrl
});
```

### SettlementContext type

The `SettlementContext` interface defines the handoff contract between upstream handlers and the middleware:

```ts
interface SettlementContext {
  settlementId: string;
  txHash: string;
  validBefore?: number;
  timedOut: boolean;
}
```

## Project Structure

```
src/
  types.ts          — SettlementState, SettlementProfile, PROFILES, SettlementContext
  state-machine.ts  — In-memory state machine (StateMachine, SettlementRecord)
  poller.ts         — viem-based RPC polling loop (pollUntilResolved)
  middleware.ts      — Express middleware with timedOut trigger
  index.ts          — Public API exports
test/
  state-machine.test.ts
  poller.test.ts
  middleware.test.ts
```

## Limitations

- **In-memory only** — No persistence. Records are lost on process restart. Replace with a database-backed store for production.
- **No queues or retries** — The poller runs synchronously in the request cycle (fire-and-forget). Background workers and retry logic are not included.
- **Minimal middleware handoff** — The middleware only triggers on `res.locals.x402Settlement.timedOut === true`. Deeper integration (e.g. automatic timeout detection, request lifecycle hooks) is left to the caller.
- **No telemetry** — Errors in the fire-and-forget poller branch are silently swallowed.
- **Single-machine scope** — One middleware instance creates one `StateMachine`. Multi-process deployments need external coordination.

## License

Apache 2.0

## Author

Allan Mang'eni Wanyonyi
