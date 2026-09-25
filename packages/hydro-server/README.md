# Hydro server

The local API stores manual problem drafts, runs file-based Docker verification, and publishes immutable Hydro and private authoring ZIPs. It also serves a separate streaming AI chat powered by `pi-ai`; chat has no Agent tools and cannot edit drafts.

```bash
docker build -t hydro-problem-make/sandbox:local packages/hydro-server/sandbox
npm run dev:hydro-api
```

The listener is `http://127.0.0.1:4321`. Set `HYDRO_WEB_ROOT` to a built web directory if the API should also serve the frontend. Override the image with `HYDRO_SANDBOX_IMAGE`.

## Manual authoring API

| Route | Purpose |
| --- | --- |
| `GET/POST /api/projects` | List drafts or create a blank draft |
| `GET/PUT/DELETE /api/projects/:id` | Read, update, or delete a draft and its releases |
| `GET/PUT/DELETE /api/projects/:id/files/:name` | Stream a `.in`, `.out`, or `.ans` file; GET accepts `?origin=manual` or `?origin=generated` when names overlap, PUT uses `application/octet-stream` |
| `POST /api/projects/:id/cases` | Add one text test case atomically with `{ name?, input, output?, subtaskId? }`; returns filenames and the updated project |
| `POST /api/projects/:id/generate` | Compile Gen once, replay each script command twice, run validator/reference/oracle/checker, atomically replace generated cases |
| `POST /api/projects/:id/finalize` | Full Docker verification, Hydro directory and format checks, two ZIPs |
| `GET /api/releases` | List completed immutable releases |
| `GET /api/releases/:id/hydro` | Download the Hydro import ZIP |
| `GET /api/releases/:id/source` | Download the private authoring ZIP with sources, data, testlib, manifest and report |
| `GET /api/releases/:id/report` | Read the verification report |
| `POST /api/releases/:id/live-verify` | Optional real Hydro import and reference submission |

`POST /api/projects` requires `{ "scoringMode": "acm" | "oi" }`; the mode cannot change after creation. ACM uses one 100-point `min` group and requires every test to pass. OI retains editable `sum`, `min`, and `max` subtasks. Every new problem uses a testlib text Checker by default; custom C++ testlib Checker source is optional.

Verified ACM releases may be exported with `POST /api/releases/:id/exports/domjudge`, `/fps`, or `/qduoj`, then downloaded from the corresponding `GET /api/releases/:id/{domjudge,fps,qduoj}` route. OI releases are Hydro-only. FPS and QDUOJ exports currently accept the default text Checker, converted to their native two-argument SPJ; a custom testlib Checker cannot be converted safely. `PUT/GET/DELETE /api/projects/:id/domjudge-pdf` manages an optional PDF, which is frozen into the next release and included in its DOMjudge ZIP as `problem.pdf`. Without it, the DOMjudge ZIP has no statement.

`GET/POST /api/contests` and `GET/PUT/DELETE /api/contests/:id` manage contest drafts. `POST /api/contests/:id/export` accepts `{ "format": "hydro" | "domjudge" }`; `GET /api/contest-releases` lists immutable bundles and `GET /api/contest-releases/:id/download` serves one. Hydro bundles contain ordered individual problem ZIPs and a manifest, so import each problem and add it to a Hydro contest. DOMjudge bundles contain `problems.yaml` with labels, balloon color names and RGB values plus individual problem ZIPs. Create the DOMjudge contest first, import `problems.yaml`, then upload each problem ZIP as described in the [DOMjudge import manual](https://www.domjudge.org/docs/manual/8.3/import.html). DOMjudge bundles reject OI problems; contest schedule and participants are configured on the destination platform. A project referenced by a contest draft must be removed from that contest before it can be deleted; previously exported contest bundles remain downloadable.

The reference program is required before release. OI drafts default to one `sum` subtask worth 100 points and may assign tests to `sum`, `min`, and `max` subtasks. Uploaded answers are checked against the reference. A testlib SPJ can accept text that differs from the reference when it awards full score; malformed or altered-output probes must be rejected. A validator, when present, must accept every formal input. An independent program, when present, must agree with the reference on each test. Without these optional sources, the report explicitly marks the corresponding evidence as absent.

For `POST /cases`, `input` is required but may be an empty string, which creates a zero-byte `.in`. Omitting `output` leaves answer generation to the reference; `output: ""` creates a zero-byte `.out`. A blank or omitted `name` selects the next numeric `.in` name after all manual and generated cases. The endpoint rejects existing case stems and invalid subtask IDs. Input and output text are each limited to 1 MiB of UTF-8; larger tests use the file upload route. Adding a manual case invalidates an earlier Gen batch until the script is rerun.

The local sandbox uses GCC 16.2.0. Reference and independent C++ programs, Gen, validator, and SPJ each select C++11, C++14, C++17, C++20, C++23, or experimental C++26; the default is C++17. C++26 uses GCC's `-std=c++26` mode; GCC does not yet implement every C++26 feature. Python 3 and Java remain available for reference and independent programs. Gen source may include `testlib.h`. A script has one command per nonempty line, such as `gen large 1000000 100`; quotes and `#` comments are supported. The API parses arguments and invokes the compiled `gen` directly, without a shell. Generated tests are numbered after manual tests. Rerunning the script replaces the previous generated batch only after the new batch passes.

The selected standard controls local compilation. If a SPJ uses features newer than C++17, the target Hydro judge must also provide a compiler and checker language configuration that can compile it. A local pass alone does not prove that a different Hydro installation supports the same compiler mode; the optional live Hydro check verifies that deployment.

The default size limits are 64 MiB per data file and 512 MiB per project. Set `HYDRO_CASE_MAX_BYTES` and `HYDRO_PROJECT_MAX_BYTES` to positive integer byte limits. The target Hydro judge profile defaults to 100 cases and 60,000 ms combined time; set `HYDRO_TESTCASES_MAX` and `HYDRO_TOTAL_TIME_LIMIT_MS` to match your instance. The local sandbox accepts 50–10,000 ms and 32–512 MiB per case. All data files and archives are streamed or copied without embedding data in JSON.

Drafts, chats and releases are stored under `.hydro-problem-make/projects`, `chats`, and `releases`; set `HYDRO_WORKSPACE_ROOT` to choose another root. AI profiles are stored in `ai-config.json` and are never returned with their keys.

## AI chat

`GET /api/ai/config` lists saved API/model profiles without returning keys. `PUT /api/ai/config` creates a named profile, or updates one when the body includes its `id`; an empty key on update retains that profile's stored key. `PUT /api/ai/config/default` selects the default profile, `DELETE /api/ai/config/:id` deletes one, and `DELETE /api/ai/config` clears all. Existing single-model `ai-config.json` files load as a named legacy profile and are converted on the next save. The three protocols are `openai-completions`, `openai-responses`, and `anthropic-messages`. Each profile has a model ID, API key, optional Base URL, `contextWindow`, and `maxTokens`.

`GET/POST /api/chats`, `GET/DELETE /api/chats/:id`, and `POST /api/chats/:id/messages` manage persistent conversations. The message body accepts `profileId` to select a saved profile; otherwise it uses the conversation's last selected profile, then the default. Changing profiles keeps all saved turns in the same conversation. Assistant turns record the model and protocol used. The message endpoint sends `text/event-stream` frames: `start` contains the saved user turn, each `delta` contains new assistant text, `done` contains the saved conversation, and `error` contains the failure message. Comment heartbeats keep idle streams open. `contextSnapshot` is optional and read-only. Older turns are trimmed only from the model request when the selected profile's context budget is exceeded.

Messages may include `images: [{ name, mimeType, data }]`, where `data` is base64 without a data-URL prefix. PNG, JPEG, WebP and GIF are accepted, with at most four images, 5 MiB each and 12 MiB total per message. Text may be empty when images are present. Image bytes are stored as separate local attachments; conversation JSON and SSE events contain only image metadata. `GET /api/chats/:id/images/:imageId` serves a saved image. Images remain in model context until earlier turns are trimmed, and are removed when the conversation is deleted. The selected model and API endpoint must support image input.

## Optional live Hydro test

Set `HYDRO_LIVE_VERIFY_COMMAND` to an executable and optionally `HYDRO_LIVE_VERIFY_ARGS` to a JSON string array. The command receives one JSON document on stdin with `version: 3`, the immutable release ID and package directory, the release-time reference program, and `wrongPrograms: []`. It returns JSON with `import: { success, message }`, `reference: { verdict, score?, accepted }`, and `wrongPrograms: []`. This result is separate from the mandatory local verification because Hydro authentication and deployment topology vary.
