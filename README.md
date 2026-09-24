# Hydro Problem Make

基于 [Pi](https://github.com/earendil-works/pi) 的本地 Hydro 制题工作台。网页中编写题面与样例，手动上传测试数据或用 Gen 生成数据，经 Docker 沙箱验证后下载 Hydro 题目 ZIP；另提供独立的 AI 对话，不会自动修改草稿。上游基线见 [UPSTREAM.md](UPSTREAM.md)。

## 快速安装与管理

需要 Git、Node.js **22.19+**、npm，以及已启动的 Docker Desktop / Docker Engine。主机无需安装 GCC：沙箱镜像内提供 GCC 15.2、Python 3、Java 21 和 `testlib.h`。当前脚本支持 macOS、Linux 和 Windows 的 WSL，默认只监听本机 `127.0.0.1` 的 4321 与 5173 端口。

```bash
git clone https://github.com/Albert-Li-Sz/Hydro-Problem-Maker-Agent.git
cd Hydro-Problem-Maker-Agent
./install.sh
```

安装脚本以 `npm ci --ignore-scripts` 安装锁定依赖，构建本地沙箱镜像，并在后台启动 API 和网页。完成后打开 **http://127.0.0.1:5173/**。日志与进程信息保存在 `.hydro-problem-make/runtime/`。端口若已被其他程序占用，脚本会报错，不会结束那个程序。

```bash
./upgrade.sh                  # 仅在干净的 main 工作区快进到 origin/main，然后重装、重建并重启
./uninstall.sh                # 停止托管服务，删除沙箱镜像及运行日志；保留制题数据
node scripts/hydro-local.mjs status
node scripts/hydro-local.mjs stop
node scripts/hydro-local.mjs start
```

三个脚本均支持 `--dry-run` 查看将执行的操作。升级不会暂存、覆盖或合并本地改动。卸载默认保留 `.hydro-problem-make/` 中的草稿、测试文件、发布包、聊天记录和 API 配置；`./uninstall.sh --purge-data` **永久删除这些数据**，`--remove-deps` 还会删除根目录的共享 `node_modules`。脚本不会删除仓库源码。修改过存储目录时，请另外管理自定义目录。

需要手动开发时，可分别运行 `npm run dev:hydro-api` 和 `npm run dev:hydro-web`；先用 `docker build -t hydro-problem-make/sandbox:local packages/hydro-server/sandbox` 准备沙箱。不要同时启动脚本托管服务和手动服务，以免端口冲突。

## 制题流程

1. 在**题面与样例**中编辑 Markdown 题面、公开样例和附件；题面预览与导出包共用同一份内容。
2. 在**测试数据**中直接填写空输入或任意自定义输入，可选填期望输出；也可批量上传 `.in`、`.out`、`.ans`。未给出的输出由标准程序生成，已上传的输出会与标准程序核对。
3. 在 **Gen 生成**中粘贴或上传 C++ `testlib.h` 生成器和脚本。脚本每行一条 `gen ...` 命令；生成点接在手动点之后，重复运行会核对可复现性。
4. 在**程序与 SPJ**中填写必需的标准程序；可选填第二标准程序、testlib 输入校验器和 C++ testlib SPJ。各 C++ 源文件可选择 C++11、14、17、20、23 或实验性 C++26；标准程序和第二标准程序也支持 Python 3、Java。
5. 点击**验证并打包**。全部本地校验通过后才能下载 Hydro ZIP 和包含源码、数据、验证报告的私有制题工程 ZIP。**制题记录**可重新打开草稿并下载历史包；真实 Hydro 导入检查是单独的可选步骤。

当前手工流程支持普通程序题和 C++ testlib SPJ，尚不支持交互题或提交答案题。详细接口和限制见 [服务端说明](packages/hydro-server/README.md)。

## AI 对话

在**设置**中添加多个 API / 模型配置，协议可选 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages，并设置模型 ID、上下文长度、输出长度和密钥。对话按流式 Markdown 显示，可上传或粘贴图片；只在主动勾选时附带当前题面与标程的只读快照。配置和聊天记录只保存在本地。

| 目录 | 职责 |
| --- | --- |
| [`packages/hydro-authoring`](packages/hydro-authoring) | Hydro 包结构、验证与 ZIP 生成 |
| [`packages/hydro-server`](packages/hydro-server) | 草稿持久化、Docker 验证、发布包与 AI 对话接口 |
| [`packages/hydro-web`](packages/hydro-web) | React/Vite 制题工作台与对话界面 |

运行 `npm run check` 检查代码；需要定向测试时参见各包说明。

## 致谢

- 感谢 [Hydro](https://github.com/hydro-dev/Hydro) 提供题目格式和评测行为参考。本项目的前端样式独立实现，与 Hydro 官方项目无隶属关系。
- 感谢 [Mike Mirzayanov 的 Testlib](https://github.com/MikeMirzayanov/testlib) 提供生成器、输入校验器和 checker 能力；沙箱中附带的版本与许可信息见 [testlib 说明](packages/hydro-server/sandbox/testlib/README.md)。
- 感谢 [Codeforces Polygon](https://polygon.codeforces.com/) 的制题流程为 Gen 脚本、数据验证和打包设计提供思路。
- 感谢 [Pi](https://github.com/earendil-works/pi) 提供本项目的代码基础与 `pi-ai`。

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
