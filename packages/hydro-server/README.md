# Hydro server

The local API stores drafts, tasks, chats, contests and releases in `workspace.sqlite`. Large files live in SHA-256 blobs under the workspace root. Existing file-based records are migrated on first startup; their original directories remain available as rollback copies and for historical downloads. The server can start without Docker. `GET /api/health` reports whether the daemon is unavailable, the image is missing, or the sandbox is ready.

The default launcher builds the frontend and serves it from `127.0.0.1:4321`; `--mode dev` runs Vite on port 5173. See the repository README for install, upgrade, doctor, backup, restore and cleanup commands.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `workspace-schema.ts` | Versioned SQLite schema migrations, run before serving requests |
| `workspace-db.ts` | Documents, optimistic versions, immutable blobs and garbage collection |
| `manual-projects.ts` | Draft edits, test files, subtask assignments and revision checks |
| `project-pipeline.ts` | Generation, verification and publication of a frozen draft |
| `releases.ts` | Published records, downloads and exports derived from saved release sources |
| `tasks.ts`, `chat-requests.ts` | Durable work state, cancellation and persisted events |
| `execution-context.ts`, `event-stream.ts` | Explicit execution context and paginated SSE replay |
| `hydro-contracts` | Shared wire types and snapshot validation, without server dependencies |

The CLI injects one `WorkspaceDatabase` into the project and chat services. Blob writes prepare complete files in `.blob-staging` before taking a short SQLite write lock. `commitFiles` publishes immutable blobs, file references and document changes together; a failed commit leaves at most unreferenced blobs. Garbage collection rechecks references under that same lock. Transaction callbacks are synchronous: never perform asynchronous work inside them.

New draft files are read from the blob index. Legacy directories are migration input, not a second live database; release listings do not rediscover deleted records from remaining directories. Release source trees remain immutable inputs for format exporters and must still be included in workspace backups. A process crash can leave temporary staging directories; current blob garbage collection does not remove those directories automatically.

Task transitions and their persisted events commit together. SSE drains all pages after the supplied cursor before closing a completed stream, and respects socket backpressure. Sandbox code receives an `ExecutionContext` explicitly and has no dependency on the task queue.

On the web side, `api-client.ts` owns HTTP errors, revision conflicts and abortable task polling. `project-session.ts` owns pending edits, serialized autosave, conflict blocking and cancellation when another draft is opened; React subscribes through `use-project-session.ts`. `npm run check` enforces the shared-contract boundary and rejects runtime import cycles in the Hydro code.

## Authoring API

| Route | Purpose |
| --- | --- |
| `GET/POST /api/projects` | List or create ACM/OI drafts |
| `GET/PUT/DELETE /api/projects/:id` | Read, edit or delete a draft |
| `GET/PUT/DELETE /api/projects/:id/files/:name` | Stream private `.in/.out/.ans` files |
| `POST /api/projects/:id/cases` | Add a text case, including empty input/output |
| `POST /api/projects/:id/cases/batch-delete` | Remove selected manual cases |
| `GET/POST /api/projects/:id/cases/renumber` | Preview/apply numeric manual case renumbering |
| `GET /api/projects/:id/cases/:origin/:stem/preview` | Preview input and output |
| `DELETE /api/projects/:id/generated` | Remove the Gen batch |
| `POST /api/projects/:id/generate` | Queue Gen compilation and reproducibility checks |
| `POST /api/projects/:id/finalize` | Queue complete verification and packaging |
| `GET /api/releases`, `DELETE /api/releases/:id` | List or remove an unreferenced release |
| `GET /api/releases/:id/{hydro,source,report}` | Download immutable packages and report |
| `GET/POST /api/contests`, `GET/PUT/DELETE /api/contests/:id` | Contest drafts |
| `POST /api/contests/:id/export` | Queue Hydro or DOMjudge export |
| `GET /api/contest-releases/:id/download` | Download a contest bundle |

The three long-running POST routes return `202` with `{ task }`. `GET /api/tasks` and `GET /api/tasks/:id` show state; `GET /api/tasks/:id/events` is an SSE stream with event IDs and `Last-Event-ID` replay. `POST /api/tasks/:id/cancel` stops the matching Docker container, and `/retry` creates another task. A draft revision can be sent as `expectedRevision` on JSON edits and case operations or `x-expected-revision` on file operations; conflicts return `409` with the current snapshot.

`POST /api/sandbox/build` queues a Docker image build. The sandbox uses GCC 16.2, testlib, Python 3 and Java 21. C++11/14/17/20/23 are supported; C++26 is experimental. The default text checker and custom testlib checker both run before a package can be published. Limits can be adjusted with `HYDRO_CASE_MAX_BYTES`, `HYDRO_PROJECT_MAX_BYTES`, `HYDRO_TESTCASES_MAX` and `HYDRO_TOTAL_TIME_LIMIT_MS`.

## AI API

`GET/PUT/DELETE /api/ai/config` manages named profiles for OpenAI Completions, OpenAI Responses and Anthropic Messages. `POST /api/ai/config/:id/test` makes an explicit short connectivity test; it never runs automatically. `POST /api/chats/:id/messages` accepts multipart fields `requestId`, `message`, `profileId`, optional `contextSnapshot` and up to four `images` files. It returns `202` with a durable request record. `GET /api/chats/:id/requests/:requestId/events` streams `start`, `delta`, `done` and `error` events. Reconnect using `Last-Event-ID` or `?after=`; replay does not invoke the model again. Failed requests can be retried through `POST /retry` with the same request ID. Model inactivity is aborted after 45 seconds. Assistant messages include token usage when the provider reports it.
