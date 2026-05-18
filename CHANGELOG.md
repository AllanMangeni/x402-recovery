# x402-recovery

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
