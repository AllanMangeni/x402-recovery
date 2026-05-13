# x402-recovery

TypeScript middleware for the x402 payment protocol settlement recovery, using environment profiles and an in-memory state machine.

## Overview

x402-recovery provides an in-memory state machine and Express-compatible middleware for tracking and recovering x402 payment settlements. It monitors on-chain settlement status and ensures failed or pending payments are properly reconciled.

Environment profiles (`datacenter`, `east_africa_3g`, `west_africa_3g`) configure facilitator timeouts, polling intervals, and maximum poll windows so the middleware adapts to network conditions.

## Installation

```bash
pnpm install x402-recovery
```

## Usage

### State machine

```typescript
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

### Express middleware

```typescript
import express from 'express';
import { createRecoveryMiddleware } from 'x402-recovery';

const app = express();

const recovery = createRecoveryMiddleware({
  profile: 'east_africa_3g',
  rpcUrl: process.env.BASE_RPC_URL as string,
});

app.use(recovery);
```

## Project Structure

- `src/state-machine.ts` — In-memory state machine for tracking settlement states
- `src/types.ts` — SettlementState enum, SettlementProfile interface, and PROFILES configuration
- `src/poller.ts` — Base RPC polling loop (stub, internal)
- `src/middleware.ts` — Express-compatible recovery middleware

## License

Apache 2.0

## Author

Allan Mang'eni Wanyonyi
