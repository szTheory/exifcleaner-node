# CI scope and minutes budget

## Scope policy

A `classify` job runs first in `ci.yml` and exposes `outputs.scope: full | linux`. Every
downstream job that only matters when native code, packaging, or release tooling changed reads
that output and either skips outright or, for the three matrix-strategy jobs, runs a cheap no-op
`ubuntu-24.04` leg instead of the full native build/install/benchmark on all six platform tuples.

The decision is made by `scripts/classify_ci_scope.cjs`'s pure `classifyCiScope` function — a
**fail-closed allowlist**: a run stays `linux` only when **every** changed path positively matches
one of the Linux-only-safe rules below, and matches none of the full-scope overrides. Any path
nobody has listed yet, any git error, and any empty diff all fall through to `full`. There is no
default-open branch in the classifier.

### Linux-only-safe rules (`LINUX_SAFE_PATH_RULES`)

- `src-format-code` — `src/(webp|metadata|png|jpeg)/**`
- `src-format-handler` — `src/admission/*-handler.ts`
- `dist-format-code` — `dist/(webp|metadata|png|jpeg)/**`
- `dist-format-handler` — the compiled output of a format handler (`.js`, `.js.map`, `.d.ts`, `.d.ts.map`)
- `format-unit-tests` — `tests/riff.test.ts`, `tests/icc_admission.test.ts`, and per-format test files
- `format-qualification-tests` — `tests/qualification/<format>/*.test.ts` (webp, png, jpeg)
- `docs` — `docs/**`
- `root-markdown` — any top-level `*.md`
- `planning-markdown` — `.planning/**/*.md`

### Full-scope overrides (`FULL_SCOPE_OVERRIDES`, always win)

- `native` — `native/**`
- `binding-gyp` — `binding.gyp`
- `prebuilds` — `prebuilds/**`
- `scripts` — `scripts/**` (including the classifier itself)
- `shared-transaction` — `src/transaction/**` and `dist/transaction/**`
- `engine-and-public-surface` — `src|dist/{engine,fallback,index,types,result,errors}.*`
- `registry` — `src|dist/admission/registry.*`
- `packaging` — `package.json`, `package-lock.json`
- `workflows-and-config` — `.github/**`
- `corpus` — `tests/corpus/**`
- `classifier-tests` — `tests/classify_ci_scope.test.ts`
- `benchmark-tests` — any `*benchmark*.test.ts` under `tests/qualification/**`

Every rule id above is named literally in `scripts/classify_ci_scope.cjs`; this document mirrors
the source rather than restating logic that could drift from it.

## Events

- `workflow_dispatch` and `workflow_call` (the `release.yml` caller invocation, and by extension a
  tag push through `release.yml`) are **always `full`**, decided before the classifier looks at any
  diff. Because a called workflow inherits the caller's `github` context, this is enforced by three
  independent checks — the always-full event list, a workflow-name check (`workflowName !== "CI"`
  forces `full`), and a `refs/tags/` ref check — not `event_name` alone.
- `pull_request` diffs the PR's merge commit against its base (`HEAD^1..HEAD`).
- `push` to `main` is filtered too, diffing `before..head`. An unavailable, zero, or force-pushed
  `before` SHA, or any git error resolving it, is fail-closed to `full`.

No third-party diff action (`dorny/paths-filter`, `tj-actions/changed-files`) is used — the March
2025 `tj-actions/changed-files` compromise is why this repo keeps scope decisions in-repo, alongside
`release_workflow_gate.cjs` and `check_evidence_present.cjs`. Workflow-level `on.paths` /
`on.paths-ignore` is also not used: a path-filtered-out job never reports a conclusion to branch
protection, so every required status check would stay pending forever on an unrelated PR.

## The matrix-name constraint

A GitHub Actions matrix job that is _skipped_ (rather than run) reports its **unexpanded** check
name — for example `build-audit-${{ matrix.tuple }}` — not `build-audit-linux-x64`. Branch
protection's 19 required contexts are the _expanded_ per-tuple names, so a literal job-level skip
on a matrix job leaves those 14 matrix-expanded contexts pending forever on a `linux`-scope run.
Measured directly: run `35426479626` showed exactly this failure mode.

The option chosen (Plan 05 Task 2, maintainer-selected "option-a" over an aggregator-plus-
branch-protection-edit alternative) is: the three matrix-strategy jobs
(`build-audit-native`, `installed-native`, `benchmark-linux`) run a real, cheap **no-op leg on
`ubuntu-24.04`** on a `linux` scope instead of skipping — every step inside them is gated by
`needs.classify.outputs.scope != 'linux'` except a `Record scope-skipped leg` step, so the job
still reports a conclusion under its fully-expanded matrix name. The four non-matrix-strategy
gated jobs (`identity-prebuild`, `assemble-exact-native`, `immutable-sha-evidence`,
`phase-46-admission`) keep a literal job-level `if:` skip, since GitHub reports a skipped
non-matrix job as passing its required check directly.

## Per-format qualification scoping

Five formats are qualified today (`QUALIFIED_FORMATS`, sorted output: `avif`, `heic`, `jpeg`,
`png`, `webp`; HEIC and AVIF added in 62.1-09). A format's Linux
qualification suite runs on changes to its own `src/<format>/**`, its registered handler, its
`tests/qualification/<format>/**` directory, and (for jpeg/png/webp) its own
`tests/corpus/upstream/**` authority where one exists. JPEG's own `FORMAT_PATH_RULES` entry covers
`src/jpeg/**`, `src/admission/jpeg-handler.ts`, the matching `dist/` output,
`tests/qualification/jpeg/**`, and `tests/jpeg*.test.ts` (JPEG has no upstream corpus authority
path yet — that lands with the corpus in a later plan). Any change under
`tests/qualification/kit/**`, or any shared code the kit or every format depends on (for example
`src/metadata/**`), runs **every** format's suite — fail-closed, so an ambiguous or shared-surface
change never silently skips a format's evidence (D-17; see `docs/format-admission.md`'s "CI
scoping" section for the full rule).

**Implemented (Plan 56-12; JPEG added Plan 57-07).** `scripts/classify_ci_scope.cjs` exposes a
`formats` output (`classifyQualificationFormats`) alongside `scope`: a changed path selects exactly
one format only when it matches that format's own `FORMAT_PATH_RULES` entry; a path matching zero
formats (a kit/shared path) or more than one, a tag ref, or any non-`pull_request`/`push` event
bubbles the whole set to every qualified format. The selection happens **inside** the single
existing `qualification-linux` job — no new job, and no workflow-level `on.paths` filter or
job-level skip. `qualification-linux` lists `classify` in `needs` **only** to read
`outputs.formats`; it is never gated by `outputs.scope`, and `validateCiScopeWiring` (the same
script) throws if that invariant ever regresses. Its run step always executes `QUAL_KIT` (the
shared kit suites), then a bash `case` over the comma-separated `formats` output appends
`QUAL_WEBP`, `QUAL_PNG`, `QUAL_JPEG`, `QUAL_HEIC` and/or `QUAL_AVIF`; an unrecognized format name fails the step rather than
silently running nothing. `QUAL_JPEG` currently lists only `tests/qualification/jpeg/tracer.test.ts`
-- every later JPEG qualification plan appends its own suite file to this list.

**HEIC and AVIF share one engine (62.1-09).** Both brands run through `src/isobmff/**` and
`src/admission/isobmff-handler.ts`, are tested through `tests/isobmff-support/**`, and are decoded
by the one libheif authority (`tests/corpus/tools/archives/libheif-1.23.5.tar.gz`). No
`FORMAT_PATH_RULES` entry names any of those paths, so a change to the shared engine matches zero
formats and runs **every** qualified format's suite, HEIC and AVIF both, by design (62.1-RESEARCH
Pitfall 2). `FORMAT_PATH_RULES.heic` names only HEIC-exclusive paths:
`src/admission/heic-handler.ts` and its `dist/` mirror, `tests/qualification/heic/**`,
`tests/corpus/constructed/heic/**`, and the libde265 archive and license.
`FORMAT_PATH_RULES.avif` names only AVIF-exclusive paths: `src/admission/avif-handler.ts` and its
`dist/` mirror, `tests/qualification/avif/**`, `tests/corpus/constructed/avif/**`, the link-u
sample directory, and the libaom archive and licenses. `tests/classify_ci_scope.test.ts` asserts
that every shared path selects all five formats, and its negative control shows that a stand-in rule
adding `src/isobmff/` to `heic` would narrow a shared-engine change to one brand and is caught. The
`qualification-linux` run step's `case` has `heic)` and `avif)` arms. Its file lists:

- `QUAL_HEIC`: `tests/qualification/heic/oracles.test.ts`, `tests/qualification/heic/tracer.test.ts`,
  `tests/qualification/heic/decode.test.ts`
- `QUAL_AVIF`: `tests/qualification/avif/oracles.test.ts`, `tests/qualification/avif/tracer.test.ts`,
  `tests/qualification/avif/decode.test.ts`

This in-job selection, rather than a workflow-level filter or a job-level skip, is required, not a
style choice: measured directly on 2026-09-24 (re-measured 2026-09-26; unchanged) with
`gh api repos/szTheory/exifcleaner-node/branches/main/protection --jq '.required_status_checks.contexts'`,
`qualification-linux` is one of the 19 required status contexts on `main`. A required status check
that never reports a conclusion (a workflow-level `on.paths` filter, or a literal job-level skip on
a _required_ job) leaves that check pending forever on an unrelated PR — the same matrix-name trap
this document already records above for the platform-matrix jobs.

**Fail-closed on a failed or untrustworthy classification (WR-03, Plan 56-18).** A failed
`classify` job, or one that reported an empty `outputs.formats`, must never narrow the selection
to the kit suite alone — that would make the required `qualification-linux` check go green
without the JPEG, PNG, or WebP suites having run at all. The selection step also reads
`needs.classify.result` (`CLASSIFY_RESULT`); when that result is not `success`, or `FORMATS` is
empty, it derives the fallback list from `scripts/classify_ci_scope.cjs`'s own `QUALIFIED_FORMATS`
export (`node -p "require('./scripts/classify_ci_scope.cjs').QUALIFIED_FORMATS.join(',')"`) rather
than a hardcoded literal, so a newly-added format is picked up automatically. The step always
prints the effective, comma-separated format list to the hosted job log
(`qualification-linux: effective formats=...`) so the selection is auditable after the fact.
`validateCiScopeWiring` throws if the job stops reading `needs.classify.result` or the fallback
stops deriving from `QUALIFIED_FORMATS`, and `tests/classify_ci_scope.test.ts`'s "WR-03" describe
executes the real step body under `bash` (with a recording `npm` stub) to prove the fallback
behaviourally, not just by text presence. No job is added and no minutes are spent when classify
succeeds with a narrowed format list; the fallback only costs extra minutes on the failure path
it exists to cover.

## JPEG onboarding cost (Phase 57)

The last hosted `qualification-linux` run before JPEG's suites were added (Phase 56 PR head
`e9c5b9a`, run `36259855039`) took **2.52 job-minutes** (`startedAt` 17:42:26Z, `completedAt`
17:44:57Z, 2 min 31 sec) running `formats=png,webp` (249/249 tests, 0 skipped). This is the
before-JPEG baseline this section's hosted after-figure (recorded once this phase's own PR runs,
see Plan 57-15) is measured against.

Locally, `prepareOracleTools()`'s libjpeg-turbo build step alone (extract + `cmake -S ... -B ...`
configure + `cmake --build ... --target djpeg-static jpegtran-static rdjpgcom jpeg-static
--parallel 2`, pinned CMake flags: shared libraries disabled, SIMD disabled, arithmetic decode
enabled/encode disabled) measured **128 seconds** in a `node:22-bookworm --platform linux/amd64`
container (57-08, Task 3). This is the single largest new fixed cost JPEG's oracle authority adds
to a cold qualification run — libwebp's and libpng's authorities were already paid for before this
phase.

The hosted `qualification-linux` job-minute figure with JPEG's suites (`formats=png,webp,jpeg`)
included is recorded in Plan 57-15, once this phase's own PR has a real hosted run to measure.

## Oracle authorities are built once per job (Phase 60, KIT-09)

Before Phase 60, `prepareOracleTools()` was memoized only in-process (`preparedTools ??=`), one
memo slot per `oracles.ts` module (`kit`, `png`, `jpeg`, `webp`). Each format's oracle test file
cold-built all five pinned authorities (libwebp, ExifTool, libpng, pngcheck, libjpeg-turbo)
independently, and `png/oracles.test.ts` built twice within the same file (two top-level describe
blocks each reaching `tools()` first) -- five cold builds in one `qualification-linux` job where
one would do (see "KIT-09 root cause (D-01)" in the workspace's
`.planning/phases/60-kit-readiness-and-png-aggregate-cap/60-EVIDENCE.md` for the corrected cause).

`scripts/qualification/build-oracles.cjs` now builds each authority exactly once per job:

- `node scripts/qualification/build-oracles.cjs --prepare "$EXIFCLEANER_ORACLE_DIR"` runs once,
  before `npm test`, in **both** the `quality` and `qualification-linux` jobs -- a
  `qualification-linux`-only fix would leave the repeated-build cost on `quality`, which every
  other job `needs:`. It claims the job-scoped directory exclusively (`build.claim`, an exclusive
  `wx` create), runs the full build plus every existing validation and feature assertion
  (including `assertLibjpegTurboFeatures`), and writes `complete.json` last, atomically (temp file
  - rename), holding each executable's `{ path, sha256 }`, the authority summary, and toolchain
    versions.
- Every `oracles.ts` consumer (`kit`, `png`, `jpeg`, `webp`) delegates to the single
  `loadOrPrepareOracleTools()` loader in `build-oracles.cjs`. With `EXIFCLEANER_ORACLE_DIR` set,
  the loader only reads: it re-verifies every executable's sha256 against `complete.json`,
  re-runs the cheap `-version` probes, logs `oracle cache hit <dir>` to stderr, and returns
  `source: "cache"` with a no-op `dispose()` -- no consumer ever triggers a second build.
- `node scripts/qualification/build-oracles.cjs --assert-built-once "$EXIFCLEANER_ORACLE_DIR"` runs
  once, after `npm test`, in both jobs -- a structural proof that `builds.log` holds exactly one
  build line and `complete.json` is present, independent of (and not racing) the parallel Vitest
  workers.
- CI fails closed: with `CI === "true"` and `EXIFCLEANER_ORACLE_DIR` unset or pointing at an
  incomplete directory, the loader throws on the first `tools()` call (never at import time, so a
  loader can be constructed speculatively). Outside CI with no variable set, a per-process build
  via `prepareOracleTools()` is still allowed, unchanged from before this phase.
- Local runs (no `EXIFCLEANER_ORACLE_DIR`, no `CI=true`) build once per process exactly as before
  -- this change only removes the _extra_ per-module cold builds inside a single CI job.
- No `actions/cache` or any other cross-run persistence of oracle binaries is used (D-09) -- this
  phase's fix is entirely intra-job. If a future phase ever introduces cross-run reuse, the cache
  key must hash all three in-repo oracle C sources (`anim_oracle.c`, `png_decode_oracle.c`,
  `jpeg_decode_oracle.c`), since none of them are covered by the pinned-archive sha256s the
  authority manifest already checks.

Measured against run `36733106449` (the correct baseline per D-10 -- see
`.planning/phases/60-kit-readiness-and-png-aggregate-cap/60-EVIDENCE.md`'s `## KIT-09 root cause
(D-01)`): `qualification-linux` was 4.32 job-min and `quality` was 4.52 job-min before this fix.
The hosted post-fix figures for both jobs are recorded in 60-08/60-09's own evidence once this
phase's PR has a real hosted run to measure.

## How to add a new format directory

Add a `LINUX_SAFE_PATH_RULES` entry (and, if the format also needs full-scope carve-outs, a
corresponding line) in `scripts/classify_ci_scope.cjs`, plus a fixture pair in
`tests/classify_ci_scope.test.ts` proving both the new path classifies `linux` and that an
unrelated/native path still classifies `full`. `validateCiScopeWiring` (the same script) already
asserts the `ci.yml` wiring invariants and fails on any of 8 known weakening mutations, so a
format addition that only touches the allowlist tables needs no `ci.yml` change.

## Measured minutes

Job-minutes are the sum of each job's `completedAt − startedAt` (negative durations — a skipped
job reports `completedAt` one second before `startedAt` — clamped to 0), summed with:

```sh
gh run view <id> --repo szTheory/exifcleaner-node --json jobs \
  --jq '[.jobs[] | ((.completedAt|fromdateiso8601) - (.startedAt|fromdateiso8601)) | if . < 0 then 0 else . end] | add / 60'
```

Wall-clock minutes are the max `completedAt` minus the min `startedAt` across all jobs:

```sh
gh run view <id> --repo szTheory/exifcleaner-node --json jobs \
  --jq '(([.jobs[].completedAt|fromdateiso8601]|max) - ([.jobs[].startedAt|fromdateiso8601]|min))/60'
```

| Run ID        | Kind                                                         | Job-min | Wall-min | Classify verdict                                                                 |
| ------------- | ------------------------------------------------------------ | ------- | -------- | -------------------------------------------------------------------------------- |
| `35394172426` | baseline (`main` push, before the filter landed)             | 25.68   | 11.08    | n/a — classifier not yet in `ci.yml`                                             |
| `36078845053` | phase PR, full scope (touches `.github/**` and the lockfile) | 26.13   | 11.13    | `scope=full reason=path is not linux-safe: .github/dependabot.yml paths=14`      |
| `36075437586` | throwaway parser-only probe PR, linux scope                  | 2.42    | 1.58     | `scope=linux reason=every changed path matched the linux-safe allowlist paths=1` |

The linux-scope probe (2.42 job-min) is **9.4%** of the 25.68 job-min baseline — the six
`build-audit-*` and six `installed-*` legs ran as sub-4-second no-op `ubuntu-24.04` legs instead of
compiling and installing on all six platform tuples, and `identity-prebuild`,
`assemble-exact-native`, and `immutable-sha-evidence` skipped outright.

Full run IDs, per-job tables, and the required-status-check proof (all 19 branch-protection
contexts reporting `success` on the phase PR head, and `success` or `skipped` with no unexpanded
`${{` name on the probe head) are recorded in the workspace's
`.planning/phases/54-node-foundation-hygiene-and-ci-budget/54-EVIDENCE.md`, under
`## NHY-04 CI minutes`.

## How to re-measure

Run the job-minutes and wall-minutes `jq` commands above against any run ID, and read the classify
verdict from the `classify` job's log:

```sh
gh run view <id> --repo szTheory/exifcleaner-node --log --job <classify-job-id> | grep -i "scope="
```
