# Mutation testing

## Why

Line coverage says a test executed some code; a mutation score says the tests would notice if that
code were wrong. Stryker changes the source in small ways (a flipped comparison, a removed guard)
and counts how many of those mutants the suite kills. The metric is
`(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`; `CompileError`, `RuntimeError` and
`Ignored` are excluded.

There is no global score. Each source group in `mutation-floors.json` has its own floor, so a strong
group cannot hide a weak one. Floors only go up (the ratchet below).

## Isolation

The tooling lives in `tools/mutation/` with its own `package.json` and lockfile, installed with
`legacy-peer-deps`. It never touches the root `package.json` or `package-lock.json`, adds no root
script, and is not published. Dependabot tracks it as its own group. `node tools/mutation/check-isolation.mjs`
fails closed if the root manifest and the tooling change in one range, or if the tooling install leaks
into the root.

## Running locally

From the repo root:

```sh
npm ci --prefix tools/mutation
tools/mutation/node_modules/.bin/stryker run tools/mutation/stryker.config.json
# or limit it to one file, or a line range of one file
tools/mutation/node_modules/.bin/stryker run tools/mutation/stryker.config.json --mutate src/webp/riff.ts
tools/mutation/node_modules/.bin/stryker run tools/mutation/stryker.config.json --mutate src/webp/riff.ts:10-40
```

Local runs are for tuning tests. They never set floors; only the CI baseline does.

## The include set

Stryker runs only the test files in `STRYKER_TEST_ALLOWLIST` (`tools/mutation/vitest.stryker.config.ts`).
`tests/mutation_include_guard.test.ts` classifies every test file as included or deliberately excluded,
so a new test file cannot silently fall outside the mutation run, and a new `tools/mutation/` test file
must be classified there.

## Groups and floors

`mutation-floors.json` defines nine groups (webp, png, jpeg, isobmff, metadata, engine, transaction, io,
admission-core), each with a tier, a target and a floor, all in tenths of a percent. A floor is
`floor(min of three CI baseline runs)` and is raised only by a manual edit. The static check in
`tests/mutation_floors.test.ts` compares against the base revision (`MUTATION_BASE_REV`, `HEAD^1` in CI)
and fails if any floor drops.

## Disabling an equivalent mutant

A mutant that cannot change observable behavior may be disabled with exactly this comment, on the line
before the code:

```ts
// Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — the typed kind check above already rejects this input
```

The form is `// Stryker disable next-line <Mutator[,Mutator]>: <class> — <specifics>`, with a real em dash
and non-empty specifics. The class must be one of the closed set in `tools/mutation/classes.json`:

- `unobservable-message`
- `redundant-guard-after-typed-check`
- `defensive-unreachable-by-construction`
- `equivalent-arithmetic`
- `platform-constant`

Block-form `disable`/`restore`, `all`, and any unlisted mutator or class are rejected by
`tools/mutation/disable-lint.mjs`. Every disable is also recorded in `tools/mutation/ledger.json`, which
maps each pre-triage survivor to killed, equivalent (a disable with a class) or dead (code deleted).

## The PR lane

The `mutation-pr` job in `ci.yml` runs on every `pull_request`. It is never gated on scope, so every PR
gets a verdict. The classifier (`scripts/classify_ci_scope.cjs`) supplies `mutate` (changed
`src/` files) and `mutate_mode` (`none`, `tests-only`, `smoke`, `run`, `run+smoke`, `error`), and
`tools/mutation/lane.mjs` acts on them:

- `plan` decides the leg and writes `lane-plan.json`; `smoke` is a dry run that proves the tooling still
  works; `run` mutates only the changed files; `gate` writes `gate-result.json`.
- Verdicts: `pass`, `fail`, `noop` (nothing mutation-relevant), `info` (changed files outside the trust
  groups) and `error` (the lane could not decide).
- `gate-result.json` records `headSha`, `mergeSha`, `baseSha`, `strykerVersion`, `mutatedFiles`, `perFile`,
  `undetectedKeys`, `verdict`, `reason`, `smoke`, `durationSeconds` and `collapsedDigest`. The whole
  `reports/mutation/` directory is uploaded as `mutation-pr-attempt-<run_attempt>`.

The lane is advisory and is not a required check; making it required is deferred to v4.13. It runs cold
with no cache and no schedule, within a 15 minute timeout.

## The baseline workflow

The per-group baseline is a separate, dispatch-only workflow added in plan 67-09. It is the only thing
that measures floors.

## Current floors

The floors are measured in Phase 67; plan 67-14 records the measured values here.
