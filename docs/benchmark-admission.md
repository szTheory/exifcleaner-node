# WebP Benchmark Admission

The WebP benchmark is a paired artifact comparison. It measures an explicit
packed candidate against an explicit packed `v0.1.1` baseline on the same
Linux x64 runner. It never treats the current checkout as the baseline.

## Reproduce a Run

Build or obtain both tarballs, then run:

```sh
npm run benchmark:qualify -- \
  --baseline-tarball /path/to/exifcleaner-node-v0.1.1.tgz \
  --candidate-tarball /path/to/exifcleaner-node-candidate.tgz \
  --mode report \
  --output qualification-benchmark.json
```

Use `--mode admit` for a phase or release gate. Report mode always exits zero
after writing the real verdict; admit mode exits nonzero when that verdict
fails. Both modes write the machine-readable JSON and a short Markdown summary
at `<output>.md`. To replay one manifested fixture, add
`--fixture still-64k` (or another ID under `benchmarks.fixtures` in
`tests/corpus/manifest.json`). Both tarball flags remain mandatory.

The runner installs each tarball in a separate temporary project with package
scripts disabled. The baseline must identify itself as version `0.1.1` and have
SHA-256 `c2fc569b553cba360814bcce61d6882a02aba062e6d6da2193323915530a34bf`; the
two archive SHA-256 values must differ. Every sample runs one operation in a
fresh child process. Each fixture alternates baseline-first and candidate-first
rounds, discards two warmups per version, and retains fifteen measurements per
version.

## Committed Workload

Seed `460070` binds twelve generated records and their exact byte sizes and
SHA-256 values:

- still images without metadata: 64 KiB, 1 MiB, 16 MiB, and 64 MiB;
- metadata-bearing stills: 64 KiB, 1 MiB, and 16 MiB;
- animation with alpha: 1 MiB and 16 MiB;
- a 64 MiB cancellation case;
- a tiny malformed case; and
- a metadata payload one byte above the 16 MiB limit.

Large inputs are regenerated from their committed seeds. They are not stored as
large binaries and are rejected if their generated size or digest drifts.

Each retained child record includes monotonic elapsed nanoseconds, peak RSS in
KiB, start and end RSS in bytes, output size and digest, source/destination and
finalization truth, Node/OS/architecture/runner/CPU identity, and the exact
package archive digest. The cancellation sample additionally records its typed
outcome, whether any public destination exists, whether finalization is
truthful, whether a second writer ran, and both finalization-start and terminal
latencies.

## Admission Formulas

Correctness and finalization truth are evaluated before any performance value.
A mismatch cannot be offset by a faster result.

For every non-cancellation fixture, the candidate must satisfy all of these
inclusive limits:

- median time ≤ `max(baseline median × 1.20, baseline median + 15 ms)`;
- p95 time ≤ `max(baseline p95 × 1.35, baseline p95 + 30 ms)`;
- median peak-RSS increase ≤ 16 MiB; and
- RSS slope across the 1/16/64 MiB no-metadata stills ≤ baseline slope + 0.10
  byte per payload byte.

RSS slope is `(RSS at 64 MiB - RSS at 1 MiB - 4 MiB tolerance) / 63 MiB`,
clamped at zero. The middle point is retained in the evidence and guards the
shape of the series; the locked end-to-end slope supplies the admission value.

The deterministic candidate cancellation occurs after the copy barrier and
before publication. It must return typed `aborted`, create no public
destination, begin terminal-stage finalization within 250 ms, and return a
truthful terminal outcome within 2 seconds. A truthfully reported private-stage
residue allowed by the transaction contract passes. An untruthful residue or
any second-writer outcome fails.

## Scope

The hard benchmark authority is the dedicated, non-cancelled Linux x64 run on
Node.js 22 and 24. Pull-request runs record information; explicit phase and
release admission hard-fail. Changing the `v0.1.1` baseline, fixture set,
sampling counts, formula, or threshold requires reviewed rationale and new
evidence. The runner never refreshes them automatically.

This report supports bounded time, memory-growth, output-identity, and
cancellation claims for the manifested workload. Parser admission, independent
libwebp decoding, animation-frame comparison, metadata differential checks,
transaction fault injection, and cross-platform installed-package behavior are
separate authorities. A benchmark pass does not prove decoder or color
correctness, browser parity, universal WebP conformance, or behavior for an
unmanifested container.
