# Hydro web

React workspace styled from Hydro's public visual conventions. The implementation is original CSS and does not copy Hydro UI source files.

Run the API and web development servers in separate terminals:

```bash
npm run dev:hydro-api
npm run dev:hydro-web
```

Open `http://127.0.0.1:5173`.

Use the settings page to configure the Pi Agent protocol, model ID, API key, optional Base URL, context window, and maximum output length. Once enabled, the workspace starts the Hydro authoring Skill as a background task. It shows model wait, tool execution, validation counts and token usage. On a repeated failure, use “一键继续修复” to resume the saved draft without typing a message. Use “重制 / 下一题” to start another workflow while earlier tasks continue. Task history downloads the full-verified Hydro import ZIP and its private authoring project.
