# x402-recovery Use Cases

x402-recovery solves one specific problem: when an x402 facilitator times out before receiving an on-chain confirmation, the settlement state is unknown. The library polls the chain, tracks the outcome through a seven-state machine, and gives the application a reliable ground truth to act on.

That problem is not unique to any one market or network. Anywhere that x402 settlement runs over a network path with variable latency — mobile data, satellite, high-load RPC endpoints, cross-border bridges — the Two-Phase Gap is a real risk. The named profiles in this library encode the latency baselines for specific corridors. Adding more profiles is one of the simplest ways to extend coverage.

---

## African mobile money corridors

This is the original design context for the library, and the named profiles reflect it directly.

### M-Pesa STK push linked to x402

A merchant in Nairobi runs a digital service gated behind x402 payments. The consumer's agent initiates settlement over a Base transaction. The facilitator times out after 20 seconds — within normal parameters for a 3G connection in Nairobi. The transaction eventually confirms on-chain six seconds later.

Without recovery, the merchant's backend marks the request as failed and the consumer retries, potentially paying twice. With x402-recovery using the `east_africa_mpesa` profile, the middleware registers the settlement, polls until the receipt arrives, transitions to `confirmed_late`, and allows the service to be delivered exactly once.

```ts
createRecoveryMiddleware({
  profile: 'east_africa_mpesa',
  rpcUrl: process.env.BASE_RPC_URL!,
});
```

The `east_africa_mpesa` profile sets a 20-second facilitator timeout, 7-second poll interval, and 120-second maximum poll window — calibrated to the combination of M-Pesa's STK push acknowledgement latency and Base's block time under variable connectivity.

### Mobile money bridge idempotency

A bridge converts M-Pesa float to USDC and settles outbound x402 payments on behalf of consumers who do not hold on-chain wallets directly. The bridge generates an x402 `nonce` derived from the M-Pesa transaction ID. If the bridge crashes and restarts mid-settlement, `canonicalKey` provides the stable deduplication key:

```ts
import { canonicalKey } from 'x402-recovery';

const key = canonicalKey({
  payer:  bridgeWalletAddress,
  payTo:  merchantWalletAddress,
  value:  amountInUsdc,
  nonce:  mpesaTransactionId,  // links mobile money txid to x402 nonce
});
```

Any downstream persistence layer can key records on this value. After a restart, the bridge re-checks its database before polling again, avoiding a duplicate on-chain attempt.

### West Africa MoMo (MTN, Orange, Wave)

The `west_africa_momo` profile covers corridors where mobile money acknowledgement is slightly slower — common on MTN MoMo in Ghana or Côte d'Ivoire and on Wave in Senegal. The same pattern applies: the agent pays on-chain, the facilitator times out, recovery takes over.

---

## Agentic AI payments

The x402 ecosystem is primarily being built for AI agents that pay for services autonomously — no human in the loop, no pre-registered API keys. Recovery is essential in this context because agents run continuously, sometimes in bursts, and do not have a human operator to manually retry a failed payment.

### Pay-per-inference agent

An AI agent routes different tasks to different model providers based on cost and capability. Each inference call is settled via x402. The agent is running on AWS or a VPS and the RPC endpoint is a shared public node. Under burst load, the facilitator occasionally times out.

Using the `datacenter` profile keeps the poll window tight (30 seconds) while the middleware handles recovery silently:

```ts
createRecoveryMiddleware({
  profile: 'datacenter',
  rpcUrl: process.env.BASE_RPC_URL!,
});
```

The agent never retries a payment unless the state machine definitively returns `failed` or `failed_orphaned`. It does not double-pay on a `confirmed_late` outcome.

### Agent-to-agent settlement

A coordinator agent delegates a task to a specialist data agent and pays it via x402. The coordinator has an `onTransition` hook that updates its internal task ledger:

```ts
import { createSettlementStateMachine, SettlementState } from 'x402-recovery';

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

The coordinator agent now has a reliable settlement signal and can decide whether to retry the delegation, escalate to a fallback agent, or surface the failure to the human operator.

### MCP tool monetization

An MCP server exposes a premium database query tool gated behind x402 payments. Agents from different frameworks — LangChain, CrewAI, custom — call the tool. The server uses x402-recovery to track each payment:

```ts
app.post('/tools/query', (req, res) => {
  res.locals.x402Settlement = {
    settlementId: req.headers['x-request-id'] as string,
    txHash:       req.headers['x-payment-txhash'] as string,
    validBefore:  Number(req.headers['x-payment-valid-before']),
    timedOut:     true,
  };

  // run the query
  const result = runDatabaseQuery(req.body);
  res.json(result);
});
```

The middleware handles recovery after the response is sent. Tool authors earn on every confirmed settlement.

---

## API and data monetization

### Pay-per-request API

A developer exposes a geospatial enrichment API. Clients pay per request. Under high request volume, the shared RPC endpoint occasionally runs behind. The `datacenter` profile handles recovery with a 30-second window — well within the EIP-3009 `validBefore` window for most configurations.

The `canonicalKey` function provides idempotency at the application layer:

```ts
import { canonicalKey, SettlementState } from 'x402-recovery';

async function handleRequest(settlementCtx: SettlementContext) {
  const key = canonicalKey({
    payer:  settlementCtx.payer!,
    payTo:  myWalletAddress,
    value:  settlementCtx.value!,
    nonce:  settlementCtx.nonce!,
  });

  const existing = await db.settlements.findByKey(key);
  if (existing?.state === SettlementState.Confirmed) {
    // idempotent — serve the result without re-querying the chain
    return serveResult(existing.settlementId);
  }

  // register and recover
}
```

### Financial data feed (pay-per-record)

A fintech data provider sells on-chain market data at $0.001 per record. The consumer is an automated trading agent running on Solana with a Base bridge for settlement. Cross-chain bridge latency means facilitator timeouts are frequent — not failures, just slow. The `datacenter` profile with a longer `maxPollWindowMs` override (contributed as a custom profile) handles the timing correctly.

---

## Compute and infrastructure

### GPU inference with variable RPC latency

A compute provider sells GPU inference over x402. Settlement runs on Base. During peak hours the provider's RPC endpoint is under load and facilitator timeouts spike. x402-recovery runs on the provider's Node.js backend:

```ts
createRecoveryMiddleware({
  profile: 'datacenter',
  rpcUrl: process.env.BASE_RPC_URL!,
});
```

The provider's observability stack receives structured log events from the `onTransition` hook for every `confirmed_late` settlement — useful for identifying RPC endpoint degradation before it causes customer-visible failures.

### Satellite and low-earth-orbit connectivity

A maritime vessel runs an AI agent that purchases weather routing data via x402. The connection is low-earth-orbit satellite with variable latency spikes. The `east_africa` profile (or a custom profile with a wider poll window) handles the longer confirmation path. The middleware's fire-and-forget poller does not block the HTTP response, so the agent's primary flow is not interrupted while recovery runs in the background.

---

## Beav3r pre-execution guard

The Beav3r adapter adds a pre-execution authorization gate before settlement polling. It is designed for workflows where an agent must confirm that a payment is settled before taking an irreversible downstream action — sending a payout, releasing a digital asset, or triggering a physical fulfilment.

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

## Patterns that apply across all use cases

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

---

## Contributing a new profile

If you operate in a corridor not covered by the five existing profiles, a named profile contribution is welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the process. A useful profile includes:

- A name that identifies the corridor or network type
- Documented latency baselines (where the numbers come from)
- At least one test that references the profile name

Target corridors currently missing: Philippines (GCash), Indonesia (GoPay, QRIS), Brazil (PIX bridge), India (UPI bridge), Turkey, Eastern Europe.
