# x402-recovery

## v0.2.0

### Changed

- Introduced async-capable `StateMachine` interface. The default in-memory
  implementation remains synchronous but satisfies the async-capable contract.
- Added `ReceiptProvider` abstraction. Core poller no longer depends on viem
  directly.
- Added viem receipt provider adapter via `createViemReceiptProvider`.
- Added optional `PollDispatcher` for external job queue integration.
- Added optional injected `stateMachine` in middleware config. Required when
  using `pollDispatcher`.
- Simplified built-in profiles to `datacenter` and `emerging_markets`.
- Added `requiredConfirmations` to settlement profiles (defaults to 1).
- Normalized `validBefore` handling to Unix milliseconds internally. Added
  `normalizeValidBefore` helper.
- Clarified `canonicalKey(payer, payTo, value, nonce)` as durable settlement
  identity.
- Renamed `SettlementState.Pending` to `SettlementState.Created`.
- Renamed `PollUntilResolvedParams` fields: `client` replaced by
  `receiptProvider`.

### Removed

- Removed region-specific built-in profiles (`east_africa`, `west_africa`,
  `east_africa_mpesa`, `west_africa_momo`) from exported `PROFILES`. Use
  `defineProfile` for custom profiles.

### Fixed

- Prevented dispatcher failures from breaking HTTP responses. Both sync errors
  and async rejections are caught.
- Prevented async transition callback rejections from causing unhandled
  rejections in the state machine. `onTransition` return values are wrapped in
  `Promise.resolve` and rejections are swallowed.
- Made middleware safer for duplicate settlement registration. If `create`
  throws because a record already exists, the existing record is retrieved.
- Classified unknown receipt statuses as `Unresolved` in the poller.

### Migration

1. Replace removed profile names with custom `defineProfile(...)` calls.
2. Update `SettlementState.Pending` references to `SettlementState.Created`.
3. Use `canonicalKey` for durable persistence keys.
4. Provide a shared `stateMachine` when using `pollDispatcher`.
5. Use `ReceiptProvider` or `createViemReceiptProvider(client)` instead of
   passing `client` directly to `pollUntilResolved`.
6. Check `validBefore` units. Internal convention is Unix milliseconds. Use
   `normalizeValidBefore` to convert EIP-3009 timestamps.

## 0.1.2

### Patch Changes

- Add reconciliation compatibility section to README
- Trim README: remove aspirational sections, rewrite notes and limitations
- Add `vitest` to dependabot major version ignore list
- Note `FailedOrphaned` sub-state gap as v0.2.0 milestone

## 0.1.1

### Patch Changes

- Rename `east_africa_3g` → `east_africa` and `west_africa_3g` → `west_africa` profile keys
- Add `defineProfile()` utility for inline custom profile creation with validation
- Accept `SettlementProfile` objects in `RecoveryConfig.profile` and `machine.create()`
- Add `facilitatorTimeoutMs < maxPollWindowMs` validation guard to `defineProfile`

### Known gaps

- `FailedOrphaned` has no sub-states. The x402trace reconciliation schema
  distinguishes `value_mismatch`, `recipient_mismatch`, and `not_settled` at
  this level. Sub-states are tracked as a v0.2.0 milestone.

## 0.1.0

### Patch Changes

- acc5b0d: Initial scaffold for x402 settlement recovery middleware.
- Initial release: seven-state settlement state machine, viem poller, Express middleware, African corridor profiles, Beav3r adapter, onTransition hook, EIP-3009 canonicalKey.
