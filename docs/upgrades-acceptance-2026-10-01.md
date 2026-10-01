# Setdraft 三项升级验收报告

验收日期：2026-10-01。实现基于 `da9ca6f0303bdebafb6ba31715fd905c8e8282af` 的工作区修改，尚未提交。本地已完成 Playwright、共享 Markdown 和 OpenTelemetry 三阶段验证，以及生产构建上的综合验收。OSS、独立监控栈和 OTel logs exporter 不在本次范围。

## 验收环境与结果

环境为 macOS、Node 24.18.0、npm 11.16.0、Playwright 1.63.0，使用配套 Chromium 153.0.8010.12（revision 1243）。数据库使用 PostgreSQL 18，镜像固定为 `postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`；完整测试使用本机实际 Docker 沙箱镜像 `setdraft/sandbox:local`。

| 检查 | 本地结果 | 证据与范围 |
| --- | --- | --- |
| `npm run check` | 通过 | 格式、精确依赖、运行时依赖、导入与模块边界、TypeScript、浏览器 smoke |
| `npm run build` | 通过 | 生产服务端与前端，包含更新后的源码归档 |
| `npm run test:e2e:full` | **10/10 通过**，约 1.3 分钟 | 8 个核心场景、2 个真实沙箱场景；单 worker，无重试、无跳过 |
| Markdown / 网页定向测试 | 12/12 通过 | 作者层 4 个、题面预览 8 个；补充检查 Setext 标题和共享引用契约 |
| 服务端定向测试 | 分两批 110/110、39/39 通过 | HTTP、账号、队列、聊天、PDF、Markdown、沙箱及遥测；两批覆盖有交集，不作为 149 个独立测试统计 |
| `npm run test:scripts` | 35 通过、3 跳过 | 跳过项为已有的可选 SearXNG 网络集成测试；部署、脱敏、CI 门禁和归档测试均通过 |
| 浏览器组件独立构建 | 通过 | 实际 `ProblemPreview` 与 `ChatMarkdown` 的 308 个构建输入未引入 Node 或 OTel SDK |
| CI / Compose YAML | 通过解析与契约测试 | 核心 / 完整分层、发布依赖和环境传递已接入；远端工作流尚未触发 |

## 第一阶段：浏览器基线

核心测试使用构建后的前端、真实 HTTP API、PostgreSQL 和 PDF 编译。每个场景独立创建 schema、受限数据库角色、临时工作区、账号及题目；安装初始化与重启发生在该场景自己的服务实例。测试结束后清理自身资源，没有使用正式数据。

8 个场景覆盖安装和登录、多标签退出、会话恢复及过期、自动保存与刷新/重启恢复、快速切题、账号隔离、附件预览、聊天流式显示与错误/重试/取消、文档搜索、真实 PDF 预览和下载。自动保存通过服务端 GET 确认持久化值；账号隔离检查题目、附件、聊天和发布包的服务端访问结果。AI 由启动脚本注入确定性 faux 客户端，控制通过进程 IPC 完成。

固定 A+B 下载 fixture 用于核心 UI 回归。完整测试另外通过真实沙箱证明生成、验证和发布链路，两类证据分别保留。

完整链路运行 C++/testlib 生成器、validator、C++ 标程、Python 第二标程及文本 checker。生成报告确认 2 个生成用例和 2 个第二标程检查，发布报告确认 3 个测试点及样例检查。下载后直接检查 ZIP 条目和内容：

| 数据 | 输入 | 答案 |
| --- | --- | --- |
| 手工用例 | `1 2` | `3` |
| 生成用例 1 | `5 6` | `11` |
| 生成用例 2 | `7 8` | `15` |

Hydro 包包含题面、配置、附件和上述实际数据；DOMjudge 包检查根目录配置和 `data/secret/002.in`、`002.ans` 的对应内容。作者程序源码不被当作正式测试数据附带导出。另一个真实沙箱场景验证标程编译失败不产生发布包、生成器阶段取消终止任务，以及修改源码后的独立重试成功。

PR 与普通 main 验证运行核心浏览器测试；镜像发布前的 main / 标签 / 手动发布验证复用沙箱构建运行完整测试，失败阻止发布。完整验证已包含核心场景，避免在同一次发布验证中重复运行。已有单元、集成和沙箱门禁保留。

## 第二阶段：Markdown 与 PDF

题面、聊天和出题文档接入浏览器可用的共享 Markdown 模块和网页包装组件，保留 ReactMarkdown、聊天代码复制/高亮及 cmarker/Typst。题面和聊天启用 GFM、数学公式，文档启用 GFM；AST 不入库。

`fixtures/markdown/` 的同组 fixture 被作者层、网页和 PDF 测试使用，覆盖引用式链接、跨栏目定义、重复定义首个优先、实体和转义字符、混合大小写 `file://`、查询/片段后缀、代码块、表格、脚注、公式、缺失附件、非法文件名和危险 URL。网页与 PDF 定位到相同附件；PDF 改写只作用于编译文本，测试确认服务端保存的题面原文未变。文档导航根据顶层二级标题 AST 分章，包括 Setext 标题，代码块中的 `##` 不参与导航。

复杂度超限时网页显示转义原文和短提示；校验报告提供稳定诊断代码和源码位置。URL 安全规则及附件定位共用同一模块。

完整测试实际导出竞赛 PDF、读取全文并渲染完整题面页 PNG；浏览器同时加载真实预览页。人工查看完整页面确认题名、时间/内存、中文段落、数学公式、SVG 附件、GFM 表格、输入输出、双栏样例、提示和页脚均显示，未发现空白、内容截断或越界。PDF 来自真实验证后的发布快照。

## 第三阶段：OpenTelemetry

服务端注入 `Observability`，默认使用空实现。启用时使用 OTLP HTTP/protobuf，服务名默认 `setdraft`，默认父级采样、根 trace 采样 10%；测试使用 100%。SDK 不进入浏览器，中立 telemetry 接口保留。

7 个遥测定向测试通过内存 exporter、真实本地 HTTP/protobuf 接收器及真实持久化队列，检查 HTTP 响应结束/连接关闭、SSE 分类、父子关系、并发隔离、任务提交/取消/重试、聊天重试和服务恢复、AI 客户端总耗时/首 token/usage、低基数指标、敏感内容排除、默认关闭零请求、无效配置停用、exporter 故障和 5 秒关闭上限。本地接收器实际收到 traces 与 metrics 的 protobuf 请求及认证 headers。

传播元数据存入既有任务选项和聊天 payload JSON，重试更新本次关联，旧记录缺少元数据仍可执行；遥测字段不参与业务指纹。排队不保留活跃 span，执行记录等待时间；中断、取消、超时、校验失败和清理分别记录结果。PDF 记录父进程观察到的完整编译耗时。

原生部署与 Compose 白名单、环境传递和脱敏测试已更新。stdout 保留关联请求 ID、trace ID 和 span ID；属性白名单不包含 Cookie、密钥、题面、代码、聊天、搜索词、原始 SQL 或原始异常内容。未新增数据库表，部署默认仍为 `SETDRAFT_OTEL_ENABLED=0`。

## 本地证据与复现

以下文件为本次实际测试输出，已加入忽略规则；重新运行测试会生成新的输出，不包含在源码归档中。

- HTML 报告：`playwright-report/index.html`。
- 固定样例 PDF：`test-results/core-downloads-a-fixed-Hyd-bc164-ws-and-downloads-a-real-PDF/browser-pdf.pdf`。
- 完整竞赛 PDF：`test-results/full--sandbox-generates-va-97fd9-ge-and-exports-contest-PDFs/contest-booklet.pdf`。
- 完整题面页渲染：上述完整场景目录中的 `pdf-rendered-page.png`。
- 实际发布包：上述完整场景目录中的 `a-plus-b-e2e.hydro.zip` 和 `a-plus-b-e2e.domjudge.zip`。

失败时另存截图、trace 和脱敏服务日志，CI 保留 14 天。配置与 fixture 已纳入源码归档，报告、下载和临时数据排除。

复现命令与数据库/沙箱前提见 [测试说明](testing.md)；默认关闭及启用 OTLP 的完整配置见 [OpenTelemetry 配置](observability.md)。本地验收不代表远端 CI 已运行，也未进行正式部署或第三方判题站导入验收。
