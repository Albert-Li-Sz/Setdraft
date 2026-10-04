# Setdraft server

The API stores identity, sessions, problems, tasks, chats, contests and releases in PostgreSQL 18. Files live in immutable SHA-256 blobs under `users/<userId>/`. SQLite is no longer supported or imported. `GET /api/health` checks the database and returns only `{ "status": "ok" }`; authenticated `/api/system/status` adds sandbox readiness.

The default Docker Compose launcher builds the frontend and serves it on `0.0.0.0:4321` by default (`SETDRAFT_HOST=127.0.0.1` restricts it to loopback); `--native --mode dev` runs Vite on port 5173. See the repository README for install, upgrade, doctor, backup, restore and cleanup commands.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `database-schema.ts`, `postgres.ts` | Versioned PostgreSQL schema, restricted connection pool and forced row-level security, run before serving requests |
| `workspace-db.ts` | Documents, optimistic versions, immutable blobs and garbage collection |
| `manual-projects.ts` | Problem edits, test files, subtask assignments and revision checks |
| `project-pipeline.ts` | Generation, verification and publication of a frozen problem |
| `project-history.ts` | Atomic restoration from release sources and independent cross-user copies |
| `releases.ts` | Published records, downloads and exports derived from saved release sources |
| `tasks.ts`, `chat-requests.ts` | Durable work state, cancellation and persisted events |
| `execution-context.ts`, `event-stream.ts` | Explicit execution context and paginated SSE replay |
| `hydro-contracts` | Shared wire types and snapshot validation, without server dependencies |

`identity.ts` owns the independent identity database; `auth-http.ts` validates origins, cookies, CSRF and account roles. `workspace-registry.ts` selects services using the verified session user. Client-supplied user IDs never select the source workspace. The copy endpoint accepts a recipient ID only to create a new independent problem in that recipient’s workspace; it never returns their content. Every account has its own UUID-scoped rows and `users/<id>/` files. Team AI and web-search settings live in the identity schema. Web receives only the restricted `setdraft_app` role; migrations and offline maintenance use a separate administrator connection. PostgreSQL advisory locks and the filesystem lock enforce one active API process per deployment.

`execution-scheduler.ts` admits at most two sandbox tasks and four AI calls globally, one of each per user. Connectivity probes share the AI scheduler; image builds run exclusively against sandbox work. Logout leaves durable work running, while disabling an account cancels its unfinished work. Restart recovers queued work across all users and marks interrupted executions for explicit retry.

Each workspace injects one `WorkspaceDatabase` into its project and chat services. Blob writes prepare complete files in `.blob-staging` before taking a short PostgreSQL advisory transaction lock. `commitFiles` publishes immutable blobs, file references and document changes together; a failed commit leaves at most unreferenced blobs. Garbage collection rechecks references under that same lock. Transaction callbacks are asynchronous and retain the same client and user context through AsyncLocalStorage. Stage slow filesystem work before the transaction.

New problem files are read from the blob index. Fresh deployments do not import legacy directories; release listings do not rediscover deleted records from remaining directories. Release source trees remain immutable inputs for format exporters and must still be included in workspace backups. A process crash can leave temporary staging directories; current blob garbage collection does not remove those directories automatically.

Task transitions and their persisted events commit together. SSE drains all pages after the supplied cursor before closing a completed stream, and respects socket backpressure. Sandbox code receives an `ExecutionContext` explicitly and has no dependency on the task queue.

On the web side, `api-client.ts` owns HTTP errors, revision conflicts and abortable task polling. `project-session.ts` owns pending edits, serialized autosave, conflict blocking and cancellation when another problem is opened; React subscribes through `use-project-session.ts`. `npm run check` enforces the shared-contract boundary and rejects runtime import cycles in the Setdraft code.

## Authentication API

All business endpoints, direct file URLs and event streams require the same session boundary. Another user's resource returns 404 even for administrators. Authenticated writes also require `x-csrf-token`. Login/setup require an exact allowed `Origin`; the authenticated session snapshot supplies the CSRF token. The only public API routes are auth entry points and minimal health. SSE and downloads close when their session is revoked or expires.

| Route | Purpose |
| --- | --- |
| `GET /api/auth/session` | User, setup requirement, CSRF token and session expiry |
| `POST /api/auth/setup` | One-time setup token, username and password |
| `POST /api/auth/login` | Username and password |
| `POST /api/auth/logout` | Revoke the current session |
| `PUT /api/auth/profile` | Save the current user’s `locale` (`zh-CN`/`en`) and `avatar` (PNG/JPEG/WebP data URL, max 128 KiB decoded; `null` removes it) |
| `PUT /api/auth/password` | Current password and new password; revoke all sessions and issue a fresh one |
| `GET/POST /api/admin/users` | List accounts / create account with one-time temporary password |
| `PATCH /api/admin/users/:id` | Change role (`admin`/`user`) or enabled state |
| `POST /api/admin/users/:id/reset-password` | Temporary password and session revocation |

Passwords use asynchronous Node scrypt (`N=2^17, r=8, p=1`, random salt), at most two hashes concurrently. Session tokens are random and only SHA-256 digests are stored; cookies are HttpOnly, SameSite=Lax, and Secure with the `__Host-` prefix under HTTPS. Sessions last at most seven days, expiring after 24 hours without requests. Login limits are persisted per account and source IP; error messages do not distinguish invalid, missing or disabled accounts. Setup is transactionally single-use with a 24-hour token. Identity auditing records account operations without passwords, cookies or model keys.

Without `SETDRAFT_PUBLIC_ORIGIN`, direct HTTP access through the server IP and its listening port is supported; request Host and Origin must match. Set `SETDRAFT_PUBLIC_ORIGIN` to the exact browser origin when using your own reverse proxy or a domain. The installer does not provision a proxy or certificates. Host, Origin and CSRF checks remain active under both protocols. Forwarded IPs are trusted only from a loopback peer when a public origin is explicitly configured; a remote proxy uses its connection IP for rate limiting. The Web/API listener defaults to `0.0.0.0`; set `SETDRAFT_HOST=127.0.0.1` for a same-host proxy-only deployment. See the root README for setup-token rotation, password recovery, backup/restore and proxy configuration.

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Authoring API

| Route | Purpose |
| --- | --- |
| `GET/POST /api/projects` | List or create one of four problem types with independent ACM/OI scoring |
| `GET/PUT/DELETE /api/projects/:id` | Read, edit or delete a problem |
| `GET/PUT/DELETE /api/projects/:id/files/:name` | Stream private `.in/.out/.ans` files |
| `POST /api/projects/:id/cases` | Add a text case, including empty input/output |
| `POST /api/projects/:id/cases/batch-delete` | Remove selected manual cases |
| `GET/POST /api/projects/:id/cases/renumber` | Preview/apply numeric manual case renumbering |
| `GET /api/projects/:id/cases/:origin/:stem/preview` | Preview input and output |
| `DELETE /api/projects/:id/generated` | Remove the Gen batch |
| `POST /api/projects/:id/generate` | Queue Gen compilation and reproducibility checks |
| `POST /api/projects/:id/finalize` | Queue complete verification and packaging; optional `{ name }` is persisted across restart/retry |
| `GET/POST /api/projects/:id/runs` | Page existing runs / queue a `matrix` or full-data `pressure` run |
| `GET /api/projects/:id/runs/:runId` | Read immutable run snapshots, cells, expectations and progress |
| `GET /api/projects/:id/runs/:runId/{cell,diagnostics,artifact}` | Read cell details or download saved diagnostic files |
| `GET /api/people` | Enabled recipients, with only IDs and usernames |
| `POST /api/projects/:id/copy` | Copy current content using `{ recipientId, expectedRevision }`; never copy history |
| `GET /api/projects/:id/releases` | List this problem’s releases |
| `POST /api/projects/:id/releases/:releaseId/restore` | Restore complete source content using required `{ expectedRevision }`; retain history and increment revision |
| `PATCH /api/releases/:id` | Rename a release with `{ name }`, 1–80 characters |
| `GET /api/releases`, `DELETE /api/releases/:id` | List or remove an unreferenced release |
| `GET /api/releases/:id/{hydro,source,report}` | Download immutable packages and report |
| `GET/POST /api/contests`, `GET/PUT/DELETE /api/contests/:id` | Independent contests |
| `POST /api/contests/:id/export` | Queue Hydro or DOMjudge export with required `{ format, name }` (package log name, 1–80 characters) |
| `GET /api/contest-releases/:id/download` | Download a contest bundle |
| `POST /api/contests/:id/pdf-preview` | Compile the saved contest configuration and selected releases into a preview PDF; requires `{ expectedRevision }` |
| `GET /api/contest-releases/:id/pdf` | Download a generated contest booklet from an immutable contest release |

Long-running authoring POST routes return `202` with `{ task }`. `GET /api/tasks` and `GET /api/tasks/:id` show state; `GET /api/tasks/:id/events` is an SSE stream with event IDs and `Last-Event-ID` replay. `POST /api/tasks/:id/cancel` stops the matching Docker container, and `/retry` creates another task. Random differential runs can only be read and downloaded; new submissions, retries, replay and case import return `410`. A problem revision can be sent as `expectedRevision` on JSON edits and case operations or `x-expected-revision` on file operations; conflicts return `409` with the current snapshot.

Projects store generators as `{ id, name, language, code, remark }`, with stable aliases `gen`, `gen_1`, etc. The shared script selects aliases and passes literal arguments; only referenced generators compile. C++ and Python 3 generators run in the same sandbox and must reproduce their output. Legacy generator fields map to `gen`. Pressure runs judge selected non-AC solutions over all active cases; WA/TLE/MLE/RE expectations require at least one matching verdict and no other verdict except AC. Compilation, system and incomplete results never meet expectations. Observations warn; required expectations gate publication under the current verification contract.

Restoration checks the manifest and source hashes before replacing the editable document and all test/PDF file references in one transaction. It keeps the problem ID and creation date, increments the revision, and clears the current verification report. The release source tree must be present in backups. Copies use a fresh ID and timestamps, retain current code, attachments and both manual/generated tests, and omit releases, reports and tasks. Both operations reject stale revisions and recheck account access at commit.

Administrator-only `POST /api/sandbox/build` queues a Docker image build. The sandbox uses GCC 16.2, testlib, Python 3 and Java 21. C++11/14/17/20/23 are supported; C++26 is experimental. The default text checker and custom testlib checker both run before a package can be published. Limits can be adjusted with `SETDRAFT_CASE_MAX_BYTES`, `SETDRAFT_PROJECT_MAX_BYTES`, `SETDRAFT_TESTCASES_MAX` and `SETDRAFT_TOTAL_TIME_LIMIT_MS`.

### Problem types and communication

`problemType: standard | special | interactive | communication` is canonical. Central conversion maps legacy
`judgingMode/checkerMode` to it and derives compatibility views, preserving hidden code and data. Conflicting fields
return 422; an old client attempting a legacy judging-field update on a communication problem receives 409.
Input source remains `interactionInputMode: provided | empty`. Scoring is fixed after creation.

Communication settings are `{ judgeSource, judgeStandard, secondRound: interactive | text | custom }`.
A task compiles each contestant and jury once, then uses two fresh runtime environments. The task-local compiler
cache is never persisted or shared between tasks/users. Round one validates interaction and saves a bounded binary
handoff; round two either interacts again or receives the saved second input and compares final output. Custom
checkers receive original private input, final output and the primary solution's two-round answer. Missing/illegal
handoff and a third-round request are jury faults. A judged first-round failure scores zero and skips round two;
cancellation and infrastructure errors cannot meet a solution expectation. Each round receives independent limits;
local summaries use maximum time/memory and retain individual rounds and diagnostic references.
Communication diagnostics are capped at 512 MiB per task; temporary jury directories are removed after each case.
Source archives include `verification-summary.json` separately from the project snapshot, retaining the required
run's version, image and solution outcomes without embedding its matrix cells. Communication manifests record
the actual fixed image used by the task-local compiler cache.

`interactive-sandbox.ts` owns the interactive execution path. It compiles each role in a separate container and
mounts only that role's program at runtime. Two non-root, network-disabled, read-only containers exchange streams
through a bounded relay. Startup is bounded separately from the dialogue deadline; stderr and each direction's
saved transcript are capped at 64 KiB, while emitted stdout is limited by `maxFileBytes`. All role containers and
attached Docker processes are removed before returning. Restart cleanup uses the same task-scoped role names.
Interactor exceptions are `SYSTEM_ERROR`, contestant failures are `RE`/`TLE`/`MLE`, rejected answers are `WA`.
Memory verdicts use measured process-group peak memory and Docker OOM evidence, rather than killed signals alone.
Partial scores do not pass the full-reference gate. Interactive reports use `interactorUsed`, not `checkerUsed`.

Provided-input generation checks reproducibility and optional input validation before an actual dialogue.
Empty mode rejects generation and verifies only `interactive-empty.in`, with a strictly empty answer and no seed.
The ordinary stored `cases` remain in project snapshots, but are inactive in empty mode. Source archives retain
all original manual/generated files; the active empty case has manifest origin `automatic`, separate from those
restorable files. Explanatory public samples are never executed as batch tests.

Hydro releases retain ACM/OI subtasks and use an interactor instead of a checker. Empty mode exports one 100-point
subtask without mutating saved groups. DOMjudge exports accept only verified ACM releases and re-run the saved
reference through the exact exported `build`/`run` adapter. Contest eligibility branches by judging mode.
Communication exports add Hydro `multi_pass: 2` and DOMjudge 9.0.1 interactive/multi-pass configuration with
`limits.validation_passes: 2`. Handoffs travel only through jury-private `nextpass.in`, never contestant-shared
`state.txt`. FPS/QDUOJ reject communication and interactive releases. Local adapters do not replace real platform
import/submission acceptance. Verification contract 7 and export contract 5 make older reports historical only.

### Structured statements and contest PDFs

Projects may include `statementSections` with `description`, `input`, `output`, `interaction`, `communication`,
`firstRound`, `secondRound` and `notes`. Ordered `protocolSamples` group judge/contestant messages by round;
legacy two-column samples are retained without guessing their order.
The structured formatter includes the active ordinary/interactive fields and public samples in statement output.
Absent sections retain legacy `statement` behavior; the editor offers the old text intact in the description field.
Hidden sections survive mode switches. Structured content participates in validation, fingerprints, source snapshots,
history restoration and copies. Interactive public samples describe the protocol and are never batch-executed.

Contests accept `pdf` settings: `enabled`, `subtitle`, `author`, `date`, `coverNotes`, `titlePage`, `problemList`,
`headerFooter`, `language`, `titlePageLanguage` and `problemLanguage`. The default language is `zh` or `en`;
cover and problem-label languages additionally support `auto`. These settings render selected immutable releases,
not live project drafts. A cancellable child process parses Markdown, validates image assets, converts content through
`contest-pdf-document.ts` into escaped Typst documents and compiles the booklet and individual statements. Local
uploaded images and bundled formula support are used without fetching arbitrary remote images. The renderer directly
adapts the pinned XCPC template and loads its eight original bundled fonts. It uses the upstream lockfile's
WASM compiler and driver (`0.6.1-rc5`), with default fonts disabled and no system-font discovery.
No TeX installation, font-path setting or runtime package download is needed. See `assets/README.md` for provenance,
layout regression coverage, license notices and the separate Founder font permission caveat.

When enabled, contest bundles include `booklet.pdf` and `statements/<label>.pdf`, and DOMjudge problem ZIPs carry
the generated per-problem PDF. This replaces the authoring UI's manual DOMjudge PDF upload; existing release files
remain immutable. Preview requires saved configuration and a matching contest revision. PDF generation limits
serialized content to 20 MiB, compilation to 90 seconds and global compiler concurrency to two.

PNG/JPEG/GIF assets must have valid headers, positive dimensions, at most 8192 pixels per side and 16 million pixels
per image; total raster dimensions are capped at 64 million pixels per job. SVG uses a restricted element/attribute
allowlist for basic shapes, text and gradients: at most 256 KiB, 5000 nodes and 32 levels, without embedded images,
scripts, styles, external references, `use`, filters, DTD/entity declarations or processing instructions. Gradient
references must stay within the same SVG. Each problem allows at most 20 attachments of 1 MiB each; image bytes total
at most 16 MiB per job. Generated Typst sources total at most 40 MiB; each document is limited to 1000 pages and generated
PDFs total at most 64 MiB.

Source extraction accepts 1–100 problems with unique one-to-three-letter uppercase labels. Individual source
`project.json` files are limited to 32 MiB and manifests to 2 MiB; public statement JSON is extracted sequentially and
limited to 20 MiB in aggregate before handing the job to the compiler child process.

Formula conversion rejects `\includegraphics`; authors must use Markdown image attachments instead. Length arguments
for `\hspace`, `\vspace` and `\raisebox` accept only signed numeric values with supported units
(`pt`, `bp`, `pc`, `mm`, `cm`, `in`, `em`, `ex`, `mu`, `sp`) and magnitude at most 10000, not expressions or code.
The formula evaluation scope restricts file reading, nested evaluation and document-query helpers.
Markdown uses the original cmarker 0.1.6 renderer with raw Typst disabled. HTML image paths must also pass the
validated-attachment allowlist. Sample tables preserve raw lines as in the upstream template; long sample lines
must be shortened or split by the author. The problem list is part of the cover and is hidden when the cover is off.

The integrated application is distributed under AGPL-3.0-only with earlier MIT notices preserved. The web prebuild
packages matching application sources and installation inputs at `/open-source/source.tgz`; sidebar and PDF
settings expose `/open-source/index.html` without login. Keep this source offer available when deploying modified
versions. Fonts retain separate terms; verify Founder font rights before redistribution. See the root `COPYING.md`.

The WASM compiler reads only explicitly mapped templates, local packages, validated images and generated sources.
It cannot read host files or job JSON through Typst, and its package registry cannot download additional packages.
The child process is killed on cancellation or timeout, but it is not an OS security sandbox. Its
`--max-old-space-size=384` setting bounds only the V8 old-generation heap, not WASM linear memory or total
process memory. Production deployments must retain container/cgroup memory limits and account for concurrent PDF jobs;
the compiler process does not inherit the contestant Docker sandbox's isolation guarantees.

The complete Chinese authoring guide is maintained in `docs/authoring-guide.md` and rendered by the web route
`#authoring-guide`; it covers all four problem types, publication, contest covers and platform acceptance limits.

## AI API

Administrators use `PUT/DELETE /api/ai/config` to manage named profiles for OpenAI Completions, OpenAI Responses and Anthropic Messages. `GET /api/ai/config` supplies model choices to members, omitting credentials and private upstream addresses. Administrator-only `POST /api/ai/config/:id/test` makes an explicit short connectivity test; it never runs automatically. `POST /api/chats/:id/messages` accepts multipart fields `requestId`, `message`, `profileId`, optional `contextSnapshot` and up to four `images` files. It returns `202` with a durable request record. `GET /api/chats/:id/requests/:requestId/events` streams `start`, `delta`, `done` and `error` events. Reconnect using `Last-Event-ID` or `?after=`; replay does not invoke the model again. Failed requests can be retried through `POST /retry` with the same request ID. Model inactivity is aborted after 45 seconds. Assistant messages include token usage when the provider reports it.


## Web search and database tests

`GET /api/ai/search` returns availability (administrator responses include provider/quota settings); `PUT /api/ai/search` and `POST /api/ai/search` are administrator-only configuration and connectivity checks. Chat submissions accept `webSearch`; `searchQuery` and `searchQueries` fields are rejected, including empty values. The current chat model plans 1–3 read-only queries, using necessary conversation context, before searching. Persisted `search` events include planning, per-query progress, partial failure and usage. Search results belong to the requesting user and request; retries reuse completed stages, while searching again creates a fresh plan and request. SearXNG is the default, Tavily is optional. Credentials never enter client snapshots.

`npm test --workspace=@setdraft/server` starts a disposable PostgreSQL Docker container, creates a restricted application role and isolates each test in separate schemas, then removes the container. Docker is required. To use an existing dedicated test database, set `SETDRAFT_TEST_DATABASE_URL` (maintenance role) and `SETDRAFT_TEST_APP_PASSWORD` (for a pre-created `setdraft_app` role). Never point these variables at production. Model and search provider tests use mocks; sandbox integration tests require `setdraft/sandbox:local`.
