# x402-recovery Use Cases

## Profiles

Use `defineProfile()` when the built-ins do not match your environment:

```ts
import { defineProfile, createRecoveryMiddleware } from 'x402-recovery';

const satelliteProfile = defineProfile({
  name: 'satellite_leo',
  facilitatorTimeoutMs: 30_000,
  pollIntervalMs: 10_000,
  maxPollWindowMs: 180_000,
});

createRecoveryMiddleware({ profile: satelliteProfile, rpcUrl: process.env.BASE_RPC_URL! });
```

## AI agents

### Pay-per-inference

An agent routes tasks to model providers and settles via x402. Use the `datacenter` profile with the middleware to recover silently. The agent only retries when the state machine returns `failed` or `failed_orphaned`.

### Agent-to-agent settlement

Wire `onTransition` to a task ledger:

```ts
const machine = createSettlementStateMachine({
  onTransition: (event) => {
    if (event.to === SettlementState.Confirmed || event.to === SettlementState.ConfirmedLate) {
      taskLedger.markPaid(event.settlementId);
    }
    if (event.to === SettlementState.Failed || event.to === SettlementState.FailedOrphaned) {
      taskLedger.markFailed(event.settlementId);
      alertCoordinator(event.settlementId);
    }
  },
});
```

### MCP tool monetisation

An MCP server exposes a premium tool gated behind x402. The server tracks payments with x402-recovery and routes confirmations to accounting.

## API monetisation

### Pay-per-request API

A geospatial API charges per request. Under load, the RPC endpoint lags. The `datacenter` profile recovers within 30 seconds. `canonicalKey` provides idempotency so duplicate requests do not double-charge.

### Financial data feed

A data provider sells on-chain market data at $0.001 per record. The consumer is a Solana agent with a Base bridge. A custom profile with a longer `maxPollWindowMs` handles bridge latency.

## Emerging markets

### M-Pesa-linked bridge

A Nairobi merchant gates a service behind x402. The facilitator times out after 20s; the transaction confirms six seconds later. Without recovery, the backend marks it failed and the consumer retries, potentially paying twice. With the `east_africa_mpesa` profile, the middleware polls, transitions to `confirmed_late`, and the service is delivered once.

Use `canonicalKey` for deduplication across restarts:

```ts
const key = canonicalKey({
  payer: bridgeWalletAddress,
  payTo: merchantWalletAddress,
  value: amountInUsdc,
  nonce: mpesaTransactionId,
});
```

### West Africa MoMo corridors

The same pattern applies for MTN MoMo (Ghana, Cote d'Ivoire), Orange Money (Mali), and Wave (Senegal). Timing baselines differ by corridor; use `defineProfile` or a named profile.

### Cross-border remittance

A corridor routes US diaspora deposits to Kenyan recipients via a stablecoin rail. The bridge initiates x402 settlement on Base, then triggers a mobile money payout on confirmation. Recovery confirms the on-chain outcome automatically and the payout fires without manual intervention.

## Infrastructure

### GPU inference with variable RPC latency

A compute provider sells GPU inference over x402. During peak hours, RPC load causes facilitator timeouts. The provider's Node.js backend runs x402-recovery. Structured `onTransition` logs feed the observability stack to spot RPC degradation before it causes customer-visible failures.

### Satellite connectivity

A maritime agent purchases weather routing data over a LEO satellite link with variable latency. A custom profile with a 180-second poll window handles the longer confirmation path. The middleware's fire-and-forget poller does not block the HTTP response.

### Load-balanced RPC aggregation

An RPC provider routes requests across a fleet. Under load, some paths timeout. A custom profile calibrated to the p99 latency of the slowest path triggers recovery instead of cascading failures downstream.

## Observability

Wire `onTransition` into your telemetry stack:

```ts
const machine = createSettlementStateMachine({
  onTransition: (event) => {
    console.log(JSON.stringify({
      event: 'settlement.transition',
      settlementId: event.settlementId,
      from: event.from,
      to: event.to,
      txHash: event.txHash,
      timestamp: event.timestamp,
    }));
  },
});
```

Use OpenTelemetry spans to correlate facilitator responses, middleware events, and on-chain receipts end to end.

## Missing txHash

Some facilitator timeout responses do not include a `txHash`. Register and mark `unresolved` immediately:

```ts
if (!settlementCtx.txHash) {
  machine.create(settlementCtx.settlementId, { profileName: profile, validBefore: settlementCtx.validBefore });
  machine.transition(settlementCtx.settlementId, SettlementState.Unresolved);
  // route to manual review
  return;
}
```

## Horizontal scaling

The default state machine is in-process only. For multi-instance deployments, back it with a shared store (Redis, Postgres) and key rows on `canonicalKey`.

## Contributing a profile

If you operate in a corridor not covered by the existing profiles, contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). A useful profile includes a name, documented latency baselines, and at least one test referencing the profile name.
