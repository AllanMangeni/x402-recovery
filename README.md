# x402-recovery

TypeScript middleware for the x402 payment protocol settlement recovery.

## Overview

x402-recovery provides an in-memory state machine and Express-compatible middleware for tracking and recovering x402 payment settlements. It monitors on-chain settlement status and ensures failed or pending payments are properly reconciled.

## Installation

```bash
pnpm install x402-recovery
```

## Usage

```typescript
import { createSettlementStateMachine, SettlementState } from 'x402-recovery';

const machine = createSettlementStateMachine();
```

## Project Structure

- `src/state-machine.ts` — In-memory state machine for tracking settlement states
- `src/types.ts` — SettlementState types and PROFILES configuration
- `src/poller.ts` — Base RPC polling loop (stub)
- `src/middleware.ts` — Express-compatible middleware (stub)

## License

Apache 2.0

## Author

Allan Mang'eni Wanyonyi
