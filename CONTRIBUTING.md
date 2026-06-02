# Contributing to x402-recovery

## Development setup

Node.js 20+ and npm 10+.

```bash
git clone https://github.com/AllanMangeni/x402-recovery.git
cd x402-recovery
npm ci
npm run lint
npm run build
npm test
```

`BASE_RPC_URL` is the only runtime environment variable. Tests mock all RPC calls.

## Repository structure

```text
src/
  types.ts         Enums, interfaces, PROFILES, canonicalKey
  state-machine.ts In-memory settlement state machine
  poller.ts        ReceiptProvider-based polling loop
  middleware.ts    Express middleware with dispatcher support
  index.ts         Public API exports
  adapters/
    viem.ts        Viem receipt provider adapter
    beav3r.ts      Beav3r pre-execution guard adapter
    index.ts       Adapter re-exports

test/
  state-machine.test.ts
  poller.test.ts
  middleware.test.ts
  beav3r-guard.test.ts
```

## Workflow

1. Branch from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```
2. Make changes, push, and open a PR targeting `develop`.
3. Once approved and merged to `develop`, a maintainer merges `develop` into `main` for release.

Branch naming:

- `feature/<short-description>` — new capability
- `fix/<short-description>` — bug fix
- `docs/<short-description>` — documentation
- `test/<short-description>` — tests only
- `chore/<short-description>` — tooling, deps, config

Keep PRs focused. A profile addition should not also refactor the poller.

## Adding a profile

Profiles live in `src/types.ts` inside the `PROFILES` constant:

```ts
{
  name: string;
  facilitatorTimeoutMs: number;
  pollIntervalMs: number;
  maxPollWindowMs: number;
}
```

Steps:
1. Add the entry to `PROFILES` in `src/types.ts`.
2. Update the profile table in `README.md`.
3. Add at least one test in `test/state-machine.test.ts` that exercises the profile name.
4. If the profile targets a specific corridor, document the latency assumptions in a comment next to the entry.

You can also define profiles inline with `defineProfile()` without adding a named entry.

## Adding an adapter

Adapters live under `src/adapters/`:

- Add a test file under `test/`.
- Use dynamic imports for optional peer dependencies.
- Export from `src/adapters/index.ts`.
- Document the peer dependency in `README.md` with an `npm install` instruction.

## Tests

```bash
npm test                       # Run all tests
npx vitest run --reporter=verbose  # Verbose output
```

- Every new exported function needs at least one test.
- State transitions should assert both the resulting state and the `updatedAt` timestamp.
- Adapter tests must cover the case where the optional peer dependency is absent.
- New profiles do not need dedicated poller tests, but the profile name must appear in at least one test.

## Commit and PR conventions

Conventional Commits:

| Prefix | Use for |
|---|---|
| `feat:` | New exported functionality |
| `fix:` | Bug fix |
| `docs:` | README, CONTRIBUTING, inline comments |
| `test:` | Tests only |
| `chore:` | Dependencies, build config, CI |
| `refactor:` | Internal restructure with no API change |

PR title follows the same convention. The first commit message is used in the changelog, so write it as a complete sentence from a consumer perspective.

Before opening a PR, verify:

- `npm run lint` passes
- `npm run build` passes
- `npm test` passes
- `npm pack --dry-run` shows the expected files in the tarball

Branch protection on `develop` requires the `Test (20)` CI check and one approving review.

## Release process

```bash
git checkout main
git pull origin main
git merge develop
npm ci
npm run lint
npm run build
npm test
npm audit --audit-level=high
npm pack --dry-run
npm whoami
npm publish --access public
git push origin main
```

The `release.yml` workflow exists for future use but requires an `NPM_TOKEN` secret.

### Versioning

Semver:

- Patch: bug fixes, docs, new profiles
- Minor: new adapters, new exported functions
- Major: breaking API changes

Update `package.json` version and `CHANGELOG.md` before publishing.

## Design decisions

### In-memory state only

The state machine is in-memory by design. It is a middleware primitive, not a persistence layer. Wrap it with your own storage adapter and use `canonicalKey` as the stable deduplication key.

### Fire-and-forget poller

The poller runs as a detached async task. It does not block the HTTP response. For long poll windows, move polling to a job queue. The library does not bundle a queue implementation.

### Profiles, not runtime configuration

Poll intervals and timeouts are exposed through named profiles for observability. `defineProfile()` lets you pass custom timing inline. If you need a configuration that does not fit an existing profile, either define it inline or add a named profile contribution.

### Beav3r adapter as optional peer

`@beav3r/sdk` is loaded dynamically so the package imports cleanly when Beav3r is not installed. If you add another optional adapter, follow the same pattern: dynamic import inside the adapter function, graceful degradation if the import fails.

## Open contribution areas

- Additional corridor profiles with documented latency baselines.
- Vitest coverage setup (`@vitest/coverage-v8`).
- Persistence adapter example (Redis or Postgres backed state machine using `canonicalKey`).
- OpenTelemetry trace example (documented `onTransition` hook emitting spans).
- ESM build target alongside the existing CJS output.
- TruffleHog push-event fix in `security.yml` (`github.event.before` as the base).

## Code of conduct

Critique the code, not the contributor. Respond to review comments in a timely way. If a discussion is going in circles, move it to an issue or a direct conversation rather than blocking a PR indefinitely.

Maintainers reserve the right to close PRs that are out of scope, do not follow the guidelines after feedback, or have been inactive for 30 days.
