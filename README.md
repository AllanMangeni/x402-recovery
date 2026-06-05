# x402-recovery

[![npm version](https://img.shields.io/npm/v/x402-recovery)](https://www.npmjs.com/package/x402-recovery)
[![npm downloads](https://img.shields.io/npm/dm/x402-recovery)](https://www.npmjs.com/package/x402-recovery)

Late settlement recovery for x402 facilitator timeouts.

When a facilitator times out but the chain later confirms success, clients see failure while the chain shows success. This package polls the chain and tracks the outcome through a state machine.

## States

| State | Meaning |
|---|---|
| created | Record exists, polling not started |
| polling | Actively checking chain truth |
| confirmed | Chain confirmed within facilitator timeout |
| confirmed_late | Chain confirmed after facilitator timeout |
| unresolved | Cannot safely classify the result |
| failed | Transaction reverted or recovery window ended |
| failed_orphaned | Recovery window ended after validBefore; authorization expired |

## Profiles

| Profile | Facilitator timeout | Poll interval | Max poll window | Confirmations | Indexer lag |
|---|---|---:|---:|---:|---:|
| datacenter | 5s | 2s | 30s | 1 | 0ms |
| emerging_markets | 15s | 5s | 90s | 1 | 0ms |
| batch | 30s | 8s | 48s | 1 | 10s |

Custom profiles:

```ts
import { defineProfile } from 'x402-recovery';

const profile = defineProfile({
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

## validBefore

`validBefore` is stored as Unix milliseconds. If your upstream value is EIP-3009 Unix seconds, convert it first:

```ts
import { normalizeValidBefore } from 'x402-recovery';
const validBeforeMs = normalizeValidBefore(contractValidBefore);
```

## Settlement identity

### `canonicalKey(payer, payTo, value, nonce)`

```ts
import { canonicalKey } from 'x402-recovery';
const key = canonicalKey({
  payer: '0xSender',
  payTo: '0xRecipient',
  value: '1000000000000000000',
  nonce: '42',
});
// => "0xSender:0xRecipient:1000000000000000000:42"
```

Use `canonicalKey` for persistence and idempotency. `value` and `nonce` are strings.

### `batchCanonicalKey(payer, payTo, nonce, claimTxHash)`

For batch settlements (`scheme: 'batch'`):

```ts
import { batchCanonicalKey } from 'x402-recovery';
const key = batchCanonicalKey('0xSender', '0xRecipient', '0xa3f2...', '0x60a960bd...');
```

## Usage

### x402 v2 lifecycle hooks (recommended)

```ts
import { x402ResourceServer } from '@x402/core';
import { RecoveryPlugin } from 'x402-recovery';

const server = new x402ResourceServer(facilitatorClient);

const recovery = RecoveryPlugin({
  profile: 'datacenter',
  rpcUrl: process.env.BASE_RPC_URL,
});

server.onSettleFailure(recovery.onSettleFailure);
server.onUncertainSettlement(recovery.onUncertainSettlement);
```

Or with a shared `StateMachine`:

```ts
import { createSettlementStateMachine, createRecoveryHook } from 'x402-recovery';

const machine = createSettlementStateMachine({ onTransition: logToTelemetry });

server.onSettleFailure(
  createRecoveryHook({ profile: 'datacenter', rpcUrl: '...', stateMachine: machine }),
);
```

### State machine

```ts
import { createSettlementStateMachine, SettlementState } from 'x402-recovery';

const machine = createSettlementStateMachine();

machine.create('tx-001', {
  profileName: 'emerging_markets',
  txHash: '0xabc...',
  validBefore: Date.now() + 90_000,
});

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

### Custom StateMachine

```ts
import type { StateMachine, SettlementRecord } from 'x402-recovery';

class RedisStateMachine implements StateMachine {
  async create(id: string, opts?) { /* persist to Redis */ }
  async get(id: string) { /* read from Redis */ }
  async transition(id: string, newState: SettlementState) { /* persist in Redis */ }
  async update(id: string, fields: SettlementRecordUpdate) { /* patch in Redis */ }
  async list() { /* scan Redis */ }
}
```

### `update()` for batch settlements

```ts
await machine.update('settlement-1', { settleTxHash: '0x7c6a7fe8...' });
```

## Production

- The default state machine is in-memory and per-process. Provide a persistent `StateMachine` for production. Recoveries disappear on process restart.
- For horizontal scaling, all workers must share the same `StateMachine`.
- Terminal records remain in memory indefinitely. Long-running services should implement TTL or eviction in their custom `StateMachine`.
- If the facilitator response has no `txHash`, the settlement is recorded as `unresolved` and not polled.
- `value` and `nonce` are strings by design.
- Use `canonicalKey` as the durable identity for retries and persistence.
- Logging uses `toSafeJSON()` by default to avoid leaking tx hashes or payer addresses to external log services.

## Related

- [NDSS 2026 Two-Phase Gap poster](https://www.ndss-symposium.org/wp-content/uploads/ndss26-poster-51.pdf)
- [x402 Foundation discussion](https://github.com/x402-foundation/x402/issues/2294)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache 2.0
