# Hydro agent adapter

This private package embeds Pi with the project-owned Hydro authoring Skill and a narrow tool set. It does not expose Pi's shell or general file mutation tools to authoring sessions.

Artifacts are addressed by safe run IDs and problem slugs, then stored below `artifacts/<run-id>/hydro/` in the assigned workspace.

Authoring sessions expose `select_hydro_judging`, `update_hydro_authoring`, `finalize_hydro_authoring`, the manual `verify_hydro_authoring`/`build_hydro_problem`/`validate_hydro_package` tools, exploratory `run_reference_program`, and structured `request_hydro_clarification`. Uploaded code is optional and replaceable; candidate tests never replace the selected reference. User attachments are injected into the final package without making the model reproduce binary content.

The Agent stores programs, testlib sources and case plans in small patches, so a failed component can be replaced without retransmitting the complete project. A complete patch runs quick verification immediately and returns grouped root causes. Three distinct revisions with the same leading failure signature stop the run while retaining the draft; `/api/runs/:id/retry` resets that streak. `finalize_hydro_authoring` runs full verification, checks known-wrong score ceilings, builds the package and validates its directory. Identical project revisions reuse a SHA-256 keyed cache. Downloads use the exact full-verified draft revision, case bytes and resource limits.

Private sources, seeds, data and reports live in `artifacts/<run-id>/authoring/<verification-id>/`. The separate authoring download includes these materials, the pinned testlib header and license, original statement, toolchain versions, draft revision and a SHA-256 manifest. The Hydro ZIP contains only judging files and public material. Supported releases are ordinary batch, testlib SPJ (including partial scores), interactive with up to 20 passes, and single/multi-file answer submission. Interactive tests exercise bidirectional communication, timeout, optional query-limit probes and `nextpass.in`/`state.txt` propagation. Multi-file answer submissions test ZIP extraction, missing/corrupt archives and wrong answers. Local checks do not replace mathematical correctness arguments or optional live Hydro judging.

## Complete authoring sequence

1. Save the current statement and attachments. Check that the model, Docker image and requested limits are available; classify the judging mode from the statement. A conflicting old program or title does not override a complete statement.
2. Stage the statement/scoring release plan and authoring project: reference solution, independent oracle, seeded testlib generator, strict validator, sample/boundary/random/stress cases, malformed inputs and representative wrong solutions. Add a checker, interactor or answer files for the selected mode.
3. Let each complete draft update run quick verification. Read grouped failures, patch only the responsible fields, and preserve the same fixed seeds. If the same failure persists through three revisions, use the saved diagnosis and one-click retry after changing the approach.
4. Call `finalize_hydro_authoring` with every case ID once. Full verification recompiles and replays all data, confirms oracle agreement, validator rejection, runtime limits, negative programs and mode-specific probes. It checks score ceilings before writing a package. Any failure withholds both downloads.
5. Inspect the generated Hydro directory. Download the minimal Hydro ZIP and separate private authoring ZIP. The manifest records source hash, model, skill version, testlib version, toolchain, seeds and file hashes. A configured real Hydro instance can be tested separately.

Build the local execution image from the repository root:

```bash
docker build -t hydro-problem-make/sandbox:local packages/hydro-agent/sandbox
```

Keep Docker running. Override the image using `HYDRO_SANDBOX_IMAGE`. Runs use disposable Linux containers with no network or host directory mounts. Supported per-case limits are 50–10000 ms and 32–512 MiB, up to 100 cases per invocation, and 1 MiB per output stream. The container has a 1 GiB total ceiling; C++/Python additionally use a per-process address-space limit, while Java uses the configured heap limit with separate JVM overhead. These are local authoring checks, not an exact reproduction of a target judge's accounting.

The complete authoring tool supports 300 cases per project, 16 MiB per output stream, 64 MiB of final input/output data, and a 15-minute container deadline. Testlib is pinned to `1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd`. Rebuild the image after updating this checkout.

Pi transcripts persist in `sessions/<run-id>/`. Only a successful `request_hydro_clarification` tool call moves a task to `needs_input`; plain text, provider errors, and output-length exhaustion are failures that can be retried without pretending the statement is incomplete. Clarifications resume the same transcript, and legacy tasks without a transcript reconstruct context from the original source and saved conversation.

Run the opt-in Docker tests from this package directory:

```bash
HYDRO_TEST_SANDBOX=1 node ../../node_modules/vitest/dist/cli.js --run test/sandbox.test.ts test/executor.test.ts test/authoring-project.test.ts test/modes.test.ts
```

The executor tests use an in-process faux AI provider; no live model calls are made.

For a real speed comparison, collect multiple runs of the same statement with the same model, context window and output limit for both versions, then run:

```bash
node scripts/hydro-benchmark.mjs --workspace .hydro-problem-make --baseline id1,id2,id3 --candidate id4,id5,id6
```

The script reports median execution time, model/tool rounds and success rate, and rejects mismatched model settings. The target is at least 50% lower median time without lower success rate. Older runs without recorded model settings need a new measured baseline.
