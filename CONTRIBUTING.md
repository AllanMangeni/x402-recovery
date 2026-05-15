# Contributing to x402-recovery

Thank you for your interest in contributing. This document covers everything you need to get from a fresh clone to a merged pull request.

## Table of contents

- [Project overview](#project-overview)
- [Development setup](#development-setup)
- [Repository structure](#repository-structure)
- [Making changes](#making-changes)
- [Tests](#tests)
- [Commit and PR conventions](#commit-and-pr-conventions)
- [Release process](#release-process)
- [Design decisions](#design-decisions)
- [Areas open for contribution](#areas-open-for-contribution)
- [Code of conduct](#code-of-conduct)

---

## Project overview

x402-recovery is a TypeScript middleware library that closes the Two-Phase Gap in the [x402](https://x402.org/) payment protocol. When a facilitator times out but the on-chain transaction later confirms, consumers and providers can disagree on settlement state. This library tracks that state through a seven-state machine, polls the chain until resolution, and exposes an Express middleware that triggers recovery automatically when a facilitator response times out.

The library is designed to be small, dependency-light, and composable. The runtime dependency surface is a single package (`viem`). Everything else is a peer or dev dependency.

---

## Development setup

You need Node.js 20 or later and npm 10 or later.

```bash
git clone https://github.com/AllanMangeni/x402-recovery.git
cd x402-recovery
npm ci
```

Verify the setup:

```bash
npm run lint    # TypeScript type check (tsc --noEmit)
npm run build   # Compile to dist/
npm test        # Run the full test suite with vitest
```

All three should complete with zero errors before you start making changes.

### Environment variables

The only environment variable used at runtime is `BASE_RPC_URL`. The test suite mocks all RPC calls, so you do not need a live RPC endpoint to run tests.

---

## Repository structure

```text
src/
  types.ts              Enums, interfaces, PROFILES, canonicalKey
  state-machine.ts      In-memory settlement state machine
  poller.ts             viem-based RPC polling loop
  middleware.ts         Express middleware entry point
  adapters/
    beav3r.ts           Beav3r pre-execution guard adapter
    index.ts            Adapter re-exports
  beav3r-shim.d.ts      Ambient type declarations for @beav3r/sdk (optional peer)
  index.ts              Public API re-exports

test/
  state-machine.test.ts State machine unit tests (12 tests)
  poller.test.ts        Poller unit tests (7 tests)
  middleware.test.ts    Middleware unit + concurrency tests (9 tests)
  beav3r-guard.test.ts  Beav3r guard unit tests (5 tests)

.github/
  workflows/
    ci.yml              Node 20 + 22 matrix, lint, build, test
    release.yml         Manual dispatch publish to npm
    security.yml        npm audit + TruffleHog, runs weekly Monday 03:00 UTC
  dependabot.yml        Weekly npm dependency updates
  CODEOWNERS            All files: @AllanMangeni; src/adapters/: @AllanMangeni
  PULL_REQUEST_TEMPLATE.md
```

---

## Making changes

### Branch naming

```
feat/<short-description>      New capability
fix/<short-description>       Bug fix
docs/<short-description>      Documentation only
test/<short-description>      Tests only
chore/<short-description>     Tooling, deps, config
```

### Scope

Keep pull requests focused. A PR that adds a new profile should not also refactor the poller. Smaller PRs are reviewed faster and are easier to revert if something goes wrong.

### Adding a new environment profile

Profiles live in `src/types.ts` inside the `PROFILES` constant. Each profile has three fields:

```ts
{
  name: string;              // matches the key in PROFILES
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
}
```

When adding a profile:

1. Add the entry to `PROFILES` in `src/types.ts`.
2. Update the profile table in `README.md`.
3. Add at least one test in `test/state-machine.test.ts` that exercises the profile name.
4. If the profile targets a specific network or corridor (for example, a Southeast Asia mobile profile), document the latency assumptions in a comment next to the profile entry.

### Adding a new adapter

Adapters live under `src/adapters/`. They connect x402-recovery to external payment or agent execution platforms. An adapter should:

- Have a corresponding test file under `test/`.
- Use dynamic imports for optional peer dependencies so the library does not break when the peer is absent.
- Export from `src/adapters/index.ts` so it is available from the package root.
- Document the peer dependency in `README.md` with an `npm install` instruction.

---

## Tests

The test suite uses [vitest](https://vitest.dev/). All RPC calls are mocked. There is no network access in tests.

```bash
npm test                       # Run all tests
npx vitest run --reporter=verbose  # Verbose output
```

### What to test

- Every new exported function needs at least one test.
- State transitions should assert both the resulting state and the `updatedAt` timestamp.
- Adapter tests must cover the case where the optional peer dependency is absent (the guard should degrade gracefully).
- New profiles do not need dedicated poller tests, but the profile name must appear in at least one test that passes it as configuration.

### Coverage

Coverage tooling is not yet configured as a dev dependency. If you add it, use `@vitest/coverage-v8` and document the threshold in this file.

---

## Commit and PR conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/).

Common prefixes:

| Prefix | Use for |
|---|---|
| `feat:` | New exported functionality |
| `fix:` | Bug fix in existing behaviour |
| `docs:` | README, CONTRIBUTING, inline comments |
| `test:` | New or updated tests only |
| `chore:` | Dependencies, build config, CI |
| `refactor:` | Internal restructure with no API change |

The PR title should follow the same convention. The first commit message is used in the changelog, so write it as a complete sentence describing the change from a consumer perspective.

### PR checklist

Before opening a PR, verify:

- `npm run lint` passes
- `npm run build` passes
- `npm test` passes
- `npm pack --dry-run` shows the expected files in the tarball
- The PR description explains the motivation and links any related issues

Branch protection on `main` requires the `Test (20)` CI check to pass and one approving review before merge.

---

## Release process

Releases are published to npm from the maintainer's local environment using the following sequence:

```bash
# From a clean clone of main
npm ci
npm run lint
npm run build
npm test
npm audit --audit-level=high
npm pack --dry-run

# Confirm dist/beav3r-shim.d.ts appears in the tarball output

npm whoami          # confirm you are logged in to npm
npm publish --access public
```

The `release.yml` GitHub Actions workflow exists for future use but requires an `NPM_TOKEN` secret to be configured in repository settings. The manual publish path above is the current release mechanism.

### Versioning

This project follows [semver](https://semver.org/).

- Patch: bug fixes, documentation, new profiles
- Minor: new adapters, new exported functions, non-breaking API additions
- Major: breaking changes to the existing public API

Update `package.json` version and `CHANGELOG.md` before publishing. The changelog entry should describe the change from a consumer perspective, not an internal implementation perspective.

---

## Design decisions

Understanding the reasoning behind the current design helps you make consistent contributions.

### In-memory state only

The state machine holds all settlement records in process memory. This is intentional for v0.1. The library is a middleware primitive, not a persistence layer. Consumers who need durability should wrap the state machine with their own storage adapter and use `canonicalKey` as the stable deduplication key across restarts.

### Fire-and-forget poller

The poller runs as a detached async task. It does not block the HTTP response. For long poll windows (over 60 seconds), the recommendation is to move polling to a job queue. The library intentionally does not bundle a queue implementation to avoid runtime dependency bloat.

### Profiles, not runtime configuration

Poll intervals and timeouts are not exposed as arbitrary constructor arguments. They are named profiles. This is deliberate — it forces explicit naming of the network conditions being targeted, which makes observability and debugging easier. If you need a configuration that does not fit an existing profile, add a named profile rather than threading raw numbers through.

### Beav3r adapter as optional peer

`@beav3r/sdk` is loaded dynamically so the entire package still imports cleanly in environments where Beav3r is not installed. If you add another optional adapter, follow the same pattern: dynamic import inside the adapter function, graceful degradation to `authorized: false` with an install hint if the import fails.

---

## Areas open for contribution

These are known gaps that would make good first contributions:

- **Additional corridor profiles.** Southeast Asia (Philippines GCash, Indonesia GoPay), Latin America (Brazil PIX-adjacent), and South Asia corridors would benefit from named profiles with documented latency baselines.
- **Vitest coverage setup.** Add `@vitest/coverage-v8` as a dev dependency and configure a threshold in `vitest.config.ts`.
- **Persistence adapter example.** A reference implementation showing how to back the state machine with Redis or a Postgres table, using `canonicalKey` as the row key.
- **OpenTelemetry trace example.** A documented `onTransition` hook implementation that emits spans to an OTLP collector.
- **ESM build target.** The current build is CJS-only. An ESM output alongside the existing CJS would improve compatibility with modern bundler setups.
- **TruffleHog push-event fix.** `security.yml` currently uses `github.event.repository.default_branch` as the base for push events, which produces an empty diff. The correct base for push events is `github.event.before`.

---

## Code of conduct

Be direct and technical in code review. Critique the code, not the contributor. Respond to review comments in a timely way. If a discussion is going in circles, move it to a GitHub issue or a direct conversation rather than blocking a PR indefinitely.

Maintainers reserve the right to close PRs that are out of scope, do not follow the contribution guidelines after feedback, or have been inactive for 30 days.
