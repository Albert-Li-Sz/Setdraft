# Setdraft server

The local API stores problems, tasks, chats, contests and releases in `workspace.sqlite`. Large files live in SHA-256 blobs under the workspace root. Existing file-based records are migrated on first startup; their original directories remain available as rollback copies and for historical downloads. The server can start without Docker. `GET /api/health` is an anonymous liveness probe returning only `{ "status": "ok" }`. Authenticated `GET /api/system/status` includes sandbox readiness.

The default launcher builds the frontend and serves it on `0.0.0.0:4321` by default (`HYDRO_HOST=127.0.0.1` restricts it to loopback); `--mode dev` runs Vite on port 5173. See the repository README for install, upgrade, doctor, backup, restore and cleanup commands.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `workspace-schema.ts` | Versioned SQLite schema migrations, run before serving requests |
| `workspace-db.ts` | Documents, optimistic versions, immutable blobs and garbage collection |
| `manual-projects.ts` | Problem edits, test files, subtask assignments and revision checks |
| `project-pipeline.ts` | Generation, verification and publication of a frozen problem |
| `project-history.ts` | Atomic restoration from release sources and independent cross-user copies |
| `releases.ts` | Published records, downloads and exports derived from saved release sources |
| `tasks.ts`, `chat-requests.ts` | Durable work state, cancellation and persisted events |
| `execution-context.ts`, `event-stream.ts` | Explicit execution context and paginated SSE replay |
| `hydro-contracts` | Shared wire types and snapshot validation, without server dependencies |

`identity.ts` owns the independent identity database; `auth-http.ts` validates origins, cookies, CSRF and account roles. `workspace-registry.ts` selects services using the verified session user. Client-supplied user IDs never select the source workspace. The copy endpoint accepts a recipient ID only to create a new independent problem in that recipient’s workspace; it never returns their content. The first administrator is permanently bound to the legacy root; other users have `users/<id>/workspace.sqlite` and files. `ai-configuration.ts` is shared through identity storage, while chat content remains private. The CLI's process lock enforces one server per data directory.

`execution-scheduler.ts` admits at most two sandbox tasks and four AI calls globally, one of each per user. Connectivity probes share the AI scheduler; image builds run exclusively against sandbox work. Logout leaves durable work running, while disabling an account cancels its unfinished work. Restart recovers queued work across all users and marks interrupted executions for explicit retry.

Each workspace injects one `WorkspaceDatabase` into its project and chat services. Blob writes prepare complete files in `.blob-staging` before taking a short SQLite write lock. `commitFiles` publishes immutable blobs, file references and document changes together; a failed commit leaves at most unreferenced blobs. Garbage collection rechecks references under that same lock. Transaction callbacks are synchronous: never perform asynchronous work inside them.

New problem files are read from the blob index. Legacy directories are migration input, not a second live database; release listings do not rediscover deleted records from remaining directories. Release source trees remain immutable inputs for format exporters and must still be included in workspace backups. A process crash can leave temporary staging directories; current blob garbage collection does not remove those directories automatically.

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

Without `HYDRO_PUBLIC_ORIGIN`, direct HTTP access through the server IP and its listening port is supported; request Host and Origin must match. Set `HYDRO_PUBLIC_ORIGIN` to the exact browser origin when using your own reverse proxy or a domain. The installer does not provision a proxy or certificates. Host, Origin and CSRF checks remain active under both protocols. Forwarded IPs are trusted only from a loopback peer when a public origin is explicitly configured; a remote proxy uses its connection IP for rate limiting. The Web/API listener defaults to `0.0.0.0`; set `HYDRO_HOST=127.0.0.1` for a same-host proxy-only deployment. See the root README for setup-token rotation, password recovery, backup/restore and proxy configuration.

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Authoring API

| Route | Purpose |
| --- | --- |
| `GET/POST /api/projects` | List or create ACM/OI problems |
| `GET/PUT/DELETE /api/projects/:id` | Read, edit or delete a problem |
| `GET/PUT/DELETE /api/projects/:id/files/:name` | Stream private `.in/.out/.ans` files |
| `POST /api/projects/:id/cases` | Add a text case, including empty input/output |
| `POST /api/projects/:id/cases/batch-delete` | Remove selected manual cases |
| `GET/POST /api/projects/:id/cases/renumber` | Preview/apply numeric manual case renumbering |
| `GET /api/projects/:id/cases/:origin/:stem/preview` | Preview input and output |
| `DELETE /api/projects/:id/generated` | Remove the Gen batch |
| `POST /api/projects/:id/generate` | Queue Gen compilation and reproducibility checks |
| `POST /api/projects/:id/finalize` | Queue complete verification and packaging; optional `{ name }` is persisted across restart/retry |
| `GET /api/people` | Enabled recipients, with only IDs and usernames |
| `POST /api/projects/:id/copy` | Copy current content using `{ recipientId, expectedRevision }`; never copy history |
| `GET /api/projects/:id/releases` | List this problem’s releases |
| `POST /api/projects/:id/releases/:releaseId/restore` | Restore complete source content using required `{ expectedRevision }`; retain history and increment revision |
| `PATCH /api/releases/:id` | Rename a release with `{ name }`, 1–80 characters |
| `GET /api/releases`, `DELETE /api/releases/:id` | List or remove an unreferenced release |
| `GET /api/releases/:id/{hydro,source,report}` | Download immutable packages and report |
| `GET/POST /api/contests`, `GET/PUT/DELETE /api/contests/:id` | Contest drafts |
| `POST /api/contests/:id/export` | Queue Hydro or DOMjudge export |
| `GET /api/contest-releases/:id/download` | Download a contest bundle |

The three long-running POST routes return `202` with `{ task }`. `GET /api/tasks` and `GET /api/tasks/:id` show state; `GET /api/tasks/:id/events` is an SSE stream with event IDs and `Last-Event-ID` replay. `POST /api/tasks/:id/cancel` stops the matching Docker container, and `/retry` creates another task. A problem revision can be sent as `expectedRevision` on JSON edits and case operations or `x-expected-revision` on file operations; conflicts return `409` with the current snapshot.

Restoration checks the manifest and source hashes before replacing the editable document and all test/PDF file references in one transaction. It keeps the problem ID and creation date, increments the revision, and clears the current verification report. The release source tree must be present in backups. Copies use a fresh ID and timestamps, retain current code, attachments and both manual/generated tests, and omit releases, reports and tasks. Both operations reject stale revisions and recheck account access at commit.

Administrator-only `POST /api/sandbox/build` queues a Docker image build. The sandbox uses GCC 16.2, testlib, Python 3 and Java 21. C++11/14/17/20/23 are supported; C++26 is experimental. The default text checker and custom testlib checker both run before a package can be published. Limits can be adjusted with `HYDRO_CASE_MAX_BYTES`, `HYDRO_PROJECT_MAX_BYTES`, `HYDRO_TESTCASES_MAX` and `HYDRO_TOTAL_TIME_LIMIT_MS`.

## AI API

Administrators use `PUT/DELETE /api/ai/config` to manage named profiles for OpenAI Completions, OpenAI Responses and Anthropic Messages. `GET /api/ai/config` supplies model choices to members, omitting credentials and private upstream addresses. Administrator-only `POST /api/ai/config/:id/test` makes an explicit short connectivity test; it never runs automatically. `POST /api/chats/:id/messages` accepts multipart fields `requestId`, `message`, `profileId`, optional `contextSnapshot` and up to four `images` files. It returns `202` with a durable request record. `GET /api/chats/:id/requests/:requestId/events` streams `start`, `delta`, `done` and `error` events. Reconnect using `Last-Event-ID` or `?after=`; replay does not invoke the model again. Failed requests can be retried through `POST /retry` with the same request ID. Model inactivity is aborted after 45 seconds. Assistant messages include token usage when the provider reports it.
