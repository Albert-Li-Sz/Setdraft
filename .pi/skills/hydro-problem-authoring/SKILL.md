---
name: hydro-problem-authoring
description: Turn a supplied programming-problem statement and optional authoring materials into a reviewed, tested Hydro problem project and import package. Use when creating, repairing, validating, or packaging a Hydro problem; do not use for solving a contestant submission.
---

# Hydro Problem Authoring

Produce two traceable outputs: a minimal Hydro import package and a separate authoring project containing private source material and validation evidence.

Follow [references/hydro-contract.md](references/hydro-contract.md) before creating or changing package files. The platform preloads this reference into the system prompt.

## Workflow

1. Preserve the supplied statement and files as the source revision. Extract the title, input and output contract, constraints, samples, limits, judging semantics, and requested subtasks. Prefer the actual statement over suggested metadata. User clarification in subsequent turns resolves earlier conflicts; do not ask answered questions again.
2. Normalize the release target to a structured problem specification. Keep statement edits reviewable against the source.
3. Write a correct reference solution and a genuinely independent small-instance oracle (brute force, enumeration, or a different algorithm). Write a C++ testlib generator, strict C++ testlib validator, boundary and maximum-size cases, and representative wrong solutions. Add a C++ testlib checker for special or partial scoring, an interactor for interactive tasks, or submission files for answer-only tasks. Explain the algorithm and coverage in the project's analysis.
4. Use deterministic tools for file writes, compilation, generation, validation, differential testing, judging, and packaging. Treat tool results as evidence; never infer that a command passed because the proposed code looks correct.
5. Ask concise questions in Chinese only when unresolved problem semantics affect valid inputs or expected outputs, and always use `request_hydro_clarification` to do so. Plain-text questions do not pause a run. Supplied code and suggested metadata are fallible: if they disagree with a complete statement, explain the discrepancy, generate the correct program, and continue automatically. A truncated display sample is computable, not missing semantics. Preserve its display text and compute the full answer. No-input problems use an empty `.in`. Fix compilation, generator, validator, checker and comparison failures yourself and retry.
6. Export only after the current revision passes its required gates. Record the statement revision, Skill version, model, toolchain, random seeds, artifact hashes, and validation results.

## Boundaries

- Support ordinary batch, C++ testlib SPJ, interactive tasks with up to 20 passes, and single-file or multi-file answer submission. Multi-pass is locally verified for interactive tasks. Partial scores use testlib `points`/`partially correct` and `sum`/`min`/`max` subtasks.
- A historical mention of submitting answers does not require answer-submission judging when the current statement explicitly permits programs. Use ordinary program judging in that case. Do not change an explicitly required answer-only judging mode without clarification.
- Generated programs run only through the configured sandbox. They must not receive model credentials, service credentials, or unrestricted workspace access.
- A reference solution passing answers it generated itself is insufficient evidence. Prefer an independent oracle for small cases and representative known-wrong solutions.
- Keep reference solutions, generators, validators, seeds, and internal reports in the authoring project. Do not place them in `std/`, `solution/`, or public attachments.
- Distinguish local package validity, algorithm/data validation, and live Hydro import and judging. Report each status separately.

## Platform Tools

The platform binds the run directory and restores the Pi session when the user continues a task. Use only the tools listed in the current session; do not request filesystem paths or run identifiers.

1. `run_reference_program` is an optional exploration tool. Supply any generated C++17, Python 3, or Java (`Main`) program. Set `role: candidate` for experiments and old/wrong uploaded code. Uploads never lock the reference program.
2. Call `select_hydro_judging` once to receive the short guide for this statement's judging type. Build the persistent project with focused `update_hydro_authoring` calls: programs and testlib sources, then cases and invalid inputs, then wrong programs, limits and analysis. Arrays replace their previous value. Use `#include "testlib.h"`; generator calls `registerGen(argc, argv, 1)` and uses fixed seeds; validator calls `registerValidation(argc, argv)`, enforces explicit bounds and separators, then `inf.readEof()`. For `readLong`, use `1LL` style bounds to avoid overload ambiguity. Each case uses manual `input` or seeded `generatorArgs`. Supply affordable `oracle: true` cases, invalid inputs and representative wrong programs.
3. A complete update automatically runs quick sandbox verification and returns failures grouped by cause. Repair only failed fields. Three different revisions with the same failure signature stop the run; the user can resume the saved draft with one click. Manual `verify_hydro_authoring` remains available for inspection.
4. For SPJ, call `registerTestlibCmd(argc, argv)` and check all output including EOF. Give legal/illegal probes; use `score` for exact 0–100 partial-score probes. For interactive, call `registerInteraction(argc, argv)`, flush each message, enforce query limits, and for multi-pass create `nextpass.in`/`state.txt` consistently. For answer-only, single mode has one full answer case; multi mode assigns a unique `submissionFile` for each ZIP entry, and public inputs are exported as attachments.
5. After quick passes, call `finalize_hydro_authoring` with the release metadata and every verified `caseId` exactly once. It runs full verification, checks optional wrong-program score ceilings, builds the package, and checks its directory. Do not send raw verified input/output again. `build_hydro_problem` and `validate_hydro_package` remain available for manual diagnostics.
6. Report actual verification evidence. The web page offers a Hydro ZIP and separate authoring ZIP with sources, seeds, data, toolchain and file hashes. A configured live Hydro adapter is optional and is reported separately.

If no sandbox tool is enabled, normalize the supplied complete data in format-authoring mode and explicitly report program execution as not run. Never claim sandbox execution or live Hydro judging without tool evidence.
