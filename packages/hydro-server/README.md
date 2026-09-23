# Hydro server

Small HTTP boundary for validating a structured problem and downloading its deterministic Hydro import ZIP.

```bash
npm run dev --workspace=@hydro-problem-make/server
```

The default listener is `http://127.0.0.1:4321`. Set `HYDRO_WEB_ROOT` to a built web directory when the server should also serve the frontend.

The web settings page uses `GET`, `PUT`, and `DELETE /api/ai/config`. The `provider` field selects one of `openai-completions`, `openai-responses`, and `anthropic-messages`; `modelId` is a freely entered API model ID. Configure an API key, optional Base URL, `contextWindow`, and `maxTokens`. Existing files without token limits receive defaults of 128000 and 16384. The default local file is `.hydro-problem-make/ai-config.json`; override it with `HYDRO_AI_CONFIG_PATH`. Saving configuration updates Agent availability immediately and does not send a model request.

Set `HYDRO_ENABLE_AGENT=1` to use credentials already configured for Pi instead of the local web configuration. Optional `HYDRO_MODEL_PROVIDER` and `HYDRO_MODEL_ID` values select one available model. The server stays available with deterministic validation and packaging if no model is configured.

`POST /api/runs` accepts `{ source, referenceProgram?: { language, code }, attachments?: [{ name, contentBase64 }] }` and checks model and sandbox readiness. `POST /api/runs/:id/continue` accepts `{ message, referenceProgram?, attachments? }` for waiting, failed, or cancelled tasks. `POST /api/runs/:id/retry` needs no body and resumes the saved draft after a failure. Both preserve the run ID and conversation. The manager runs two independent workflows concurrently by default and queues further work; set `HYDRO_MAX_CONCURRENT_RUNS` to an integer from 1 to 8 to change the limit. `GET /api/runs/:id/archive` downloads only a locally full-verified package.

`.hydro-problem-make/runs.json` is a compact list index. Full source, conversation and the compact structural event log live in `.hydro-problem-make/run-records/<run-id>.json`; terminal text-delta events are discarded because the final assistant response is already in the snapshot. Existing monolithic files migrate automatically and are preserved once as `runs.json.legacy.json`. Interrupted tasks await an explicit continuation after restart.

`GET /api/runs/:id/authoring` downloads the source project and validation evidence for new testlib authoring runs. `GET /api/runs/:id/authoring-report` lazily returns the complete check log without embedding it in every history response. `DELETE /api/runs/:id` deletes a terminal record and its local artifact/session directories; active or still-exiting tasks return 409. Other tasks and the AI configuration are retained.

Optional real-Hydro acceptance is provided through a local command adapter. Set `HYDRO_LIVE_VERIFY_COMMAND` to an executable and, optionally, `HYDRO_LIVE_VERIFY_ARGS` to a JSON string array. `POST /api/runs/:id/live-verify` sends one JSON document on stdin with the package directory and authoring project. Program tasks provide the reference and known-wrong programs. Answer-only tasks additionally provide `answerSubmission` with `mode`, `correctFiles` and `wrongSubmissions`; the adapter submits text or assembles a flat ZIP. The adapter must import the package and return JSON containing `import: { success, message }`, `reference: { verdict, score, accepted }`, and one `{ name, verdict, score?, accepted }` item per expected wrong submission. A run passes only when import succeeds, the reference receives 100 and every wrong submission is rejected. The result and optional `problemUrl` are saved in task history. This command is intentionally local and instance-specific because Hydro authentication and deployment topology vary.

`POST /api/sandbox/run` accepts `{ program: { language, code }, cases: [{ input, expectedOutput? }], timeLimitMs?, memoryLimitMb? }`. Languages are `cpp17`, `python3`, and `java`. Empty input is supported; omitting expectedOutput generates an answer instead of comparing. The health response includes Docker sandbox availability. See [sandbox setup](../hydro-agent/README.md).
