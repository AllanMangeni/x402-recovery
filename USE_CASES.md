# x402-recovery Use Cases

x402-recovery solves one specific problem: when an x402 facilitator times out before receiving an on-chain confirmation, the settlement state is unknown. The library polls the chain, tracks the outcome through a seven-state machine, and gives the application a reliable ground truth to act on.

This problem is universal. Anywhere that x402 settlement runs over a network path with variable latency, whether 3G networks, satellite connections, overloaded RPC endpoints, cross-border bridges, or congested urban networks, the Two-Phase Gap is a real risk. The library ships with five named profiles that encode timing baselines for specific environments. But the core feature is `defineProfile()`, which lets you tune the recovery window for any connectivity pattern you actually operate in.

The library launched in May 2026 and reached 200 downloads in the first week, organically. That early adoption came from developers solving this exact problem across different environments: emerging market payment corridors, AI agents settling payments autonomously, API providers monetising services, and infrastructure operators running infrastructure under variable load.

---

## Why the Two-Phase Gap matters

x402 splits payment settlement into two phases: verify off-chain (fast), settle on-chain (async). When the facilitator times out before the on-chain confirmation arrives, both the client and the server have incomplete information. The client sees failure. The chain shows success. Nobody is watching that window.

In a datacenter with sub-100ms latency and a dedicated RPC endpoint, that window is usually empty. On a 3G connection with 300-400ms round-trip latency, or on a satellite link with spiky latency bursts, or when the RPC endpoint is under load, the window is real. Payments can disappear into it.

The cost varies by use case. For a remittance, it is working capital tied up while manual recovery happens. For an AI agent, it is a failed task that might retry and double-pay. For an API provider, it is a missed revenue call. For infrastructure, it is operational complexity.

x402-recovery closes that window systematically. It does not change the protocol or the chain. It changes how applications respond when the three clocks, protocol time, application time, and network time, fall out of sync.

---

## The Five Built-In Profiles

The library ships with five named profiles calibrated to real network conditions:

- **`datacenter`**: 5s facilitator timeout, 30s max poll window. For low-latency environments with reliable RPC endpoints.
- **`east_africa`**: 15s facilitator timeout, 90s max poll window. Calibrated to East African mobile data and regional stablecoin corridors.
- **`west_africa`**: 15s facilitator timeout, 90s max poll window. Calibrated to West African mobile money and Polygon connectivity.
- **`east_africa_mpesa`**: 20s facilitator timeout, 120s max poll window. For M-Pesa-linked settlement bridges with STK push latency.
- **`west_africa_momo`**: 20s facilitator timeout, 120s max poll window. For MTN MoMo, Orange Money, and Wave corridors.

If none of these match your environment, `defineProfile()` lets you create one in 30 seconds:

```ts
import { defineProfile, createRecoveryMiddleware } from 'x402-recovery';

const satelliteProfile = defineProfile({
  name: 'satellite_leo',
  facilitatorTimeoutMs: 30_000,
  pollIntervalMs: 10_000,
  maxPollWindowMs: 180_000,
});

createRecoveryMiddleware({
  profile: satelliteProfile,
  rpcUrl: process.env.BASE_RPC_URL!,
});
```

That is the core idea: named profiles for common cases, `defineProfile()` for everything else.

---

## Use Cases by Category

### AI agents and autonomous systems

AI agents are the primary driver of x402 adoption. They settle payments without a human in the loop, often in bursts, sometimes under load. Recovery is essential.

**Pay-per-inference agent**: An AI agent routes different tasks to different model providers based on cost and capability. Each inference call is settled via x402. The agent runs on shared infrastructure where RPC latency is unpredictable. Using the `datacenter` profile keeps the poll window tight (30 seconds) while the middleware handles recovery silently. The agent never retries a payment unless the state machine definitively returns `failed` or `failed_orphaned`. It does not double-pay on a `confirmed_late` outcome.

**Agent-to-agent settlement**: A coordinator agent delegates a task to a specialist data agent and pays it via x402. The coordinator wires an `onTransition` hook to update its internal task ledger:

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

The coordinator now has a reliable settlement signal and can decide whether to retry the delegation, escalate to a fallback agent, or surface the failure to a human operator.

**MCP tool monetisation**: An MCP server exposes a premium database query tool gated behind x402 payments. Agents from different frameworks call the tool. The server uses x402-recovery to track each payment and routes confirmations to an accounting system. Tool authors earn on every confirmed settlement.

---

### API and data monetisation

**Pay-per-request API**: A developer exposes a geospatial enrichment API and charges per request. Under high request volume, the shared RPC endpoint occasionally runs behind. The `datacenter` profile handles recovery with a 30-second window. The `canonicalKey` function provides idempotency at the application layer so duplicate requests do not cause duplicate charges.

**Financial data feed**: A fintech data provider sells on-chain market data at $0.001 per record to automated trading agents. The consumer is an agent running on Solana with a Base bridge for settlement. Cross-chain bridge latency means facilitator timeouts are frequent. A custom profile with a longer `maxPollWindowMs` handles the timing correctly without rewriting recovery logic.

**Content and compute monetisation**: Any service that charges per transaction, video streaming micropayments, compute-on-demand pricing, database query fees, can use x402-recovery to turn facilitator timeouts from failed transactions into recoverable settlements. The user gets the service. The provider gets paid. No manual reconciliation needed.

---

### Emerging market payment corridors

This is the original design context for the library. The challenge is not unique to emerging markets, but the problem is more frequent and the cost is higher because manual recovery is slower and working capital constraints are tighter.

**M-Pesa-linked x402 bridge**: A merchant in Nairobi runs a digital service gated behind x402 payments. The consumer's agent initiates settlement over a Base transaction. The facilitator times out after 20 seconds; the cause could be an overloaded RPC endpoint, a network partition, or a slow mobile data path. The transaction eventually confirms on-chain six seconds later. Without recovery, the merchant's backend marks the request as failed and the consumer retries, potentially paying twice. With x402-recovery using the `east_africa_mpesa` profile, the middleware registers the settlement, polls until the receipt arrives, transitions to `confirmed_late`, and allows the service to be delivered exactly once.

The bridge also uses `canonicalKey` to provide stable deduplication across crashes:

```ts
import { canonicalKey } from 'x402-recovery';

const key = canonicalKey({
  payer:  bridgeWalletAddress,
  payTo:  merchantWalletAddress,
  value:  amountInUsdc,
  nonce:  mpesaTransactionId,  // links mobile money txid to x402 nonce
});
```

After a restart, the bridge re-checks its database before polling again, avoiding a duplicate on-chain attempt.

**West Africa MoMo corridors**: The `west_africa_momo` profile covers corridors where mobile money acknowledgement is slightly slower, common on MTN MoMo in Ghana or Cote d'Ivoire, Orange Money in Mali, Wave in Senegal. The same pattern applies: the agent pays on-chain, the facilitator times out, recovery takes over. The difference is in the timing baselines, which the profile handles transparently.

**Cross-border remittance settlement**: A remittance corridor routes payments from diaspora in the US to recipients in Kenya via a stablecoin rail. The bridge receives a deposit in the US, initiates an x402 settlement on Base for the equivalent USDC amount, then triggers a mobile money payout once on-chain confirmation arrives. Without recovery, a facilitator timeout can leave the recipient unpaid while the stablecoin sits in escrow. With the `east_africa` profile, recovery automatically confirms the on-chain outcome and the payout triggers without manual intervention.

---

### Infrastructure and platform operators

**GPU inference with variable RPC latency**: A compute provider sells GPU inference over x402. Settlement runs on Base. During peak hours the provider's RPC endpoint is under load and facilitator timeouts spike. x402-recovery runs on the provider's Node.js backend. The provider's observability stack receives structured log events from the `onTransition` hook for every `confirmed_late` settlement, useful for identifying RPC endpoint degradation before it causes customer-visible failures.

**Satellite and low-earth-orbit connectivity**: A maritime vessel runs an AI agent that purchases weather routing data via x402. The connection is low-earth-orbit satellite with variable latency spikes. A custom profile with a longer poll window (for example, 180 seconds) handles the longer confirmation path. The middleware's fire-and-forget poller does not block the HTTP response, so the agent's primary flow is not interrupted while recovery runs in the background.

**Load-balanced RPC aggregation**: An RPC provider services multiple chains and routes requests across a load-balanced endpoint fleet. Under load, some paths timeout while others succeed. A custom profile calibrated to the p99 latency of the slowest path ensures that timeouts trigger recovery rather than cascading failures downstream.

---

## Beav3r Pre-Execution Guard

For workflows where an agent must confirm that a payment is settled before taking an irreversible downstream action, such as sending a payout, releasing a digital asset, or triggering a physical fulfilment, the Beav3r adapter adds a pre-execution authorisation gate:

```ts
import { guardedPayment } from 'x402-recovery';

const result = await guardedPayment({
  action: {
    type:      'payout',
    amount:    '1000000',
    recipient: '0xRecipientAddress',
  },
  settlement: {
    settlementId: settlementId,
    txHash:       txHash,
    validBefore:  validBeforeTimestamp,
  },
  profile:          'west_africa_momo',
  beav3rAccountId:  process.env.BEAV3R_ACCOUNT_ID!,
});

if (result.authorized) {
  // safe to proceed with the downstream action
  await triggerPayout(result.settlementState);
}
```

Requires `@beav3r/sdk` installed as an optional dependency. Currently targets Base Sepolia. Do not use on mainnet until Beav3r publishes mainnet contract addresses.

---

## Patterns That Apply Across All Use Cases

### Observability hook

Every use case benefits from the same `onTransition` logging pattern. Wire it into your telemetry stack:

```ts
import { createSettlementStateMachine } from 'x402-recovery';

const machine = createSettlementStateMachine({
  onTransition: (event) => {
    console.log(JSON.stringify({
      event:        'settlement.transition',
      settlementId: event.settlementId,
      from:         event.from,
      to:           event.to,
      txHash:       event.txHash,
      timestamp:    event.timestamp,
    }));
  },
});
```

Use OpenTelemetry spans if you need to correlate across facilitator responses, middleware events, and on-chain receipts end to end.

### Missing txHash

Some facilitator timeout responses do not include a `txHash`. In that case there is nothing to poll. Register the settlement and mark it `unresolved` immediately:

```ts
import { SettlementState } from 'x402-recovery';

if (!settlementCtx.txHash) {
  machine.create(settlementCtx.settlementId, { profileName: profile, validBefore: settlementCtx.validBefore });
  machine.transition(settlementCtx.settlementId, SettlementState.Unresolved);
  // log and route to manual review queue
  return;
}
```

### Horizontal scaling

The state machine is in-process only. If you run multiple instances behind a load balancer, each instance has its own state. For multi-instance deployments, back the state machine with a shared store (Redis, Postgres) and key rows on `canonicalKey`. The library intentionally does not bundle persistence so that each deployment can choose the right store for its constraints.

### Contributing a new profile

If you operate in a corridor or environment not covered by the five existing profiles, a named profile contribution is welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the process. A useful profile includes:

- A name that identifies the corridor or network type
- Documented latency baselines (where the numbers come from)
- At least one test that references the profile name

Target corridors currently missing: Philippines (GCash), Indonesia (GoPay, QRIS), Brazil (PIX bridge), India (UPI bridge), Turkey, Eastern Europe. If you have data from your own deployments, we want to hear from it.
