# Setdraft Rev0.4 实施与验收记录

验收日期：2026-10-01（Asia/Shanghai）。基线为 Rev0.3 `da9ca6f0303bdebafb6ba31715fd905c8e8282af`。本版保留并集成 Playwright、共享 Markdown、默认关闭 OpenTelemetry，修复第三方审计的 25 项问题和四项搜索/界面反馈。PostgreSQL、本地文件存储、监听配置及单 Web 实例拓扑保持原有设置，不新增数据库表。

本文记录实际执行结果。源码基线、静态审计、隔离测试、真实部署与远端发布分别列出；远端 CI 和镜像发布结果在完成后补记，不能以本地通过替代。

## 环境与综合结果

本地为 macOS、Node 24.18.0、npm 11.16.0、Docker 29.6.1、Playwright 1.63.0 / 配套 Chromium 153.0.8010.12（revision 1243）。专用 PostgreSQL 18 镜像固定 digest `3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`，真实沙箱使用 GCC 16.2.0。AI 全部使用 faux 客户端或固定协议字节流，没有请求付费模型。

| 验证 | 实际结果 | 范围 |
| --- | --- | --- |
| 全套 `npm test` | **1499 项 Vitest 通过**，新增真实 checker 回归再单独通过 | AI 1098、telemetry 15、authoring 34、server 271、web 81；外部模型凭据测试 859 项按既有规则跳过；新增后累计 1500 个独立用例 |
| Node 脚本测试 | **41/41 通过，无跳过** | 部署、配置、源码归档、发布门禁、固定 SearXNG 容器、真实 PID 安全性、无 Node 的 OTLP bootstrap、搜索挂载 revision |
| `npm run check` | 通过 | 格式、精确依赖、运行时依赖、导入/模块边界、TS、浏览器 smoke |
| 生产构建 | 通过 | 真实服务端和前端、源码归档 |
| 完整浏览器测试 | **18/18 通过，约 2.9 分钟，无跳过** | 15 个核心场景、2 个真实沙箱场景、1 个密集矩阵；1 worker、0 重试 |
| 补充浏览器验证 | 新增重登/迟到回调/中断初始化/长内容场景分别通过 | 服务端持久化与页面双重断言；导航离开不停止后台回复 |
| 布局矩阵 | 72 组通过 | 320–3840px、DPR 1/2、中英文、导航展开/收起，另含 8 组低高度窗口 |
| 固定目标 FPS 导入及 SPJ 差分 | 通过 | 实际 QDUOJ parser/serializer/测试点保存；81 组输出与 bundled testlib 一致 |
| 真实 checker 协议 | 通过 | 编译实际 testlib checker，9 个满分/零分/部分分/格式错误/裁判故障场景；TS/Python/awk 均符合独立预期 |
| Web 候选镜像 smoke | 通过 | 镜像自身迁移专用 PG、启动、页面/JS/健康/API 鉴权；发布镜像另记 digest |
| 原生维护恢复演练 | 通过 | 在维护镜像中执行真实原生入口，无 Docker socket；专用 PG、损坏现场、健康目标、权限/会话/互斥 |
| 遥测传输与隔离 | 7 项专用测试通过 | 内存 exporter + 本地 OTLP HTTP/protobuf 接收器，包含 traces 和 metrics |
| 现场真实 SearXNG | 中文/英文及实际 Setdraft API 通过 | 实际挂载配置、实际容器网络，保留数据库与 Web 监听 |
| 远端 CI、版本镜像、Rev0.4 部署 | 待发布后补记 | 不将本地候选 digest 当成已发布镜像 |

## 25 项审计的实现与回归映射

以下测试均纳入现有脚本、Vitest 或 Playwright 门禁；真实 PG、Docker、importer 和浏览器边界已执行。精确场景见对应源码中的测试名。

| ID | 修复后的行为 | 验证入口 |
| --- | --- | --- |
| X01 | 本地与 DOMjudge 共用协议语义；`score(0)` 为零分，`points 1` 才为满分；故障不伪装 WA/AC | `checker-protocol.test.ts`、真实导出自检、完整 A+B 浏览器发布 |
| X02 | 部分比例向下取整且封顶 99；0.995/0.996/0.9999 不成为满分 | `checker-protocol.test.ts` 的独立预期 fixture |
| E06 | FPS 正确映射结构化输入/输出；历史单段题面给出明确参见完整题面说明 | `legacy-export-contract.test.ts` 执行固定目标 importer |
| X03 | 原生 SPJ 只处理选手输出开头一个实际 UTF-8 BOM；标准答案保持原值 | `legacy-export-contract.test.ts` 编译 SPJ/testlib，81 组差分，启用 UBSan |
| S01 | 回退绑定捕获版本 CAS，复制一致快照后在目标提交前复核源版本 | `project-history.test.ts` 的真实 PG 门控交错测试 |
| S02 | 同 stem `.out/.ans` 在提交前拒绝，失败不改索引/revision；历史冲突题仍可列出并修复 | `file-conflicts.test.ts`，覆盖不同上传顺序 |
| U01 | 导入绑定项目、字段、会话与 AbortSignal；新读取或切题使旧读取失效 | `source-import.test.ts` + 核心浏览器切题/API 内容断言 |
| U02 | 接受保存回执后才推进保存版本；较新 GET 越过旧 PUT 后补丁再次保存 | `project-session.test.ts` 保存回执竞态 |
| U03 | 同账号重登先读取最新 revision/测试点，保留本地草稿并恢复竞赛目录读取 | `project-session.test.ts` + 核心重登浏览器测试 |
| E07 | 旧打开/创建/导入回调不能接管新选择；取消创建不抢回当前项目；聊天初始读取被导航中断后可恢复 | 核心浏览器迟到响应、中断初始化与后台回复测试 |
| U04 | 标签输入保留带逗号/空格的原始草稿，解析后的值用于保存，失焦规范化 | 核心浏览器逐字输入与服务端 tags 断言 |
| E01 | 执行结束后终态失败保留结算责任，DB 恢复后补交；计算槽与持久化责任分开，不重复执行 | `tasks.test.ts`、`chat-requests.test.ts`、`terminal-settlements.test.ts` |
| E02 | CLI 异常退出仍确认 daemon 容器移除；清理失败保留 stage/占用/恢复责任 | `sandbox-cli-exit.test.ts`、`sandbox-cleanup.test.ts`、真实取消/超时集成 |
| E03 | 竞赛引用检查与提交、发布/项目删除在领域事务内完成，避免悬空引用 | `contest-references.test.ts` + `contests.test.ts` 真实 PG |
| S03 | 严格健康备份与损坏现场留档分开，缺 blob 不阻止恢复健康目标 | `scripts/test-maintenance.mjs` 真实数据库、文件及归档验证 |
| D02 | 原生维护使用选定数据目录和同目标 admin/app 连接，预检发生在停服前 | 实际原生入口恢复演练、数据库不匹配/工具预检、部署脚本测试 |
| D03 | 核验 OS 创建标识、命令、进程组；PID 复用和旧式存活记录不发送终止信号 | `process-identity.test.ts`、`hydro-local.test.mjs` 实际独立进程 |
| A01 | chunk 尾部 CR 留待后续判断 CRLF，保持 UTF-8 与合法事件边界 | `anthropic-sse-parsing.test.ts` 所有分包点及逐字节协议流 |
| A02 | refusal 增量/最终文本可见并持久化，保存结束原因 | OpenAI 协议测试、`chat-model.test.ts`、浏览器刷新拒绝文本 |
| A03 | delta 提供实时文本，final.content 提供最终正文，DB/刷新/下一轮一致 | `chat-model.test.ts`、浏览器最终正文与真实 DB 断言 |
| A04 | 结构余量随 contextWindow 调整，小窗口不被固定预留挤成 1 token | `small-context-output-budget.test.ts`、上下文裁剪/协议构造测试 |
| A05 | 达输出上限保存为不完整并显示原因；续写由用户主动发起 | raw stop reason、`chat-model.test.ts`、浏览器刷新截断标记 |
| D01 | 非尾部失败请求已有后续消息时重试返回 409；尾部失败可重试 | `chat-requests.test.ts` A失败→B成功→重试A，断言模型未再次调用 |
| E04 | 首次发送携带 attempt token，每次重试换新 token，旧 Stop 不取消新尝试 | chat request / lifecycle 测试、浏览器首次提交/停止/重试 |
| E05 | 配置读取-修改-写入整体串行化，持久化失败不提前改变内存 | `ai-configuration-concurrency.test.ts` 并发 profile/default/delete/failure |

## 四项反馈与现场结果

**R01 搜索。** 从 `10.11.149.225` 的实际搜索容器逐引擎查询，旧配置中 Bing 无结果、DuckDuckGo/Brave 超时、百度触发 CAPTCHA。使用独立候选容器验证后，现场仅更新实际挂载搜索配置为 Bing `cn.bing.com` + `360search`，保留其他配置与凭据并单独重启搜索服务。中文聚合 16 个候选、约 667ms；英文 15 个候选、约 200ms；两次均无不可用引擎。实际 Setdraft 管理员搜索 API 返回 200、5 个接受来源。原配置备份在服务器受限目录，测试容器与临时目录已清理。未调整 Web/数据库监听，未调用真实模型。

Rev0.4 新增管理员主动诊断，区分配置就绪、健康/部分健康、合法空结果、引擎不可用和过滤归零，记录固定类别、耗时、候选/接受数量，可下载脱敏 JSON。普通聊天保存来源状态和失败说明。旧线上 Web 尚未部署 Rev0.4，新增诊断页面的现场验收随版本部署补记。故障替身、限额、脱敏和固定 SearXNG 容器测试已通过。

安装器对搜索挂载文件计算内容 revision，Compose 通过标签变化重建搜索服务，避免更新源码后仍使用进程中旧配置。自定义文件内容由管理员保留，哈希不输出配置正文。

**R02 工作台。** 工作台使用整个内容区，预览正文单独限制阅读行长；左右面板共用剩余高度，配置内部滚动、运行状态置底。CodeMirror 从父容器取得高度，所有步骤页同一外框。按实际容器宽度采用 ≥1100px 配置+双栏、800–1099px 配置抽屉、<800px 编辑/预览切换；低高度窗口采用自然布局。50:50 分隔条支持拖动、键盘和双击复位。矩阵断言桌面编辑卡/运行状态底边与步骤页高度差 ≤2px，未发生整页意外横向滚动。

**R03 竞赛。** 标题、列表、空态和详情使用统一边界，题名伸缩、操作列固定，移动端使用列表→详情→返回导航。矩阵使用实际发布记录、长版本名与竞赛选题，避免只验证空白页面。

**R04 对话。** 工具栏、消息、来源、输入框共享 1120px 边界，宽屏模式最大 1600px；普通文字限制行长，长代码和表格局部滚动。流式输出在用户向上阅读时保留位置。失败、取消、拒绝、截断分别显示。模型设置依据当前读取配置，页面初始化中断后可重读，导航切走时已开始的后台回复仍完成并保存。

## 历史兼容、Markdown 与遥测

验证报告和导出元数据增加可选 `contractVersion=1`。受旧判题语义影响的 custom/interactive 报告必须重新验证，不能用于新派生导出或新竞赛选题；目标与版本进入缓存名/指纹。历史原包继续保留并标注状态，不偷偷改写。FPS 历史无结构栏目仍保留完整原文。旧任务、聊天请求缺可选传播/结束字段时正常执行；旧客户端只能安全取消未重试的初始尝试。

固定 QDUOJ commit 为 `df873278ab1b29510aa3a0979677d7aa9a53ca0e`；实际 parser/serializer/helper 接受结构化和历史 fallback 两种 FPS。该验证是固定目标契约执行，不宣称已经向在线 OJ 导入。完整 DOMjudge 链路检查生成 adapter、自检、ZIP 条目和数据；实际 DOMjudge 站点的安装配置另属现场验收。

Markdown 同组 fixture 贯穿作者层、网页和 PDF，包含跨栏目引用、首定义优先、实体/转义、大小写协议、URL 后缀、代码块、表格、脚注、公式、缺失附件和危险 URL。保存的原始题面不被改写。完整 PDF 已实际编译、抽取文字、渲染页面并查看，附件、公式、表格、中文栏目、样例及页脚没有截断或越界。ReactMarkdown 与 Typst/cmarker 保留；浏览器包检查未引入 Node 或 OTel SDK。

OpenTelemetry 仍默认 `SETDRAFT_OTEL_ENABLED=0`。内存 exporter 与本地 OTLP 接收器实际验证 traces/metrics、父子关系、并发隔离、排队恢复/重试、取消、关闭状态零导出、exporter 故障不阻塞业务、5 秒 flush 上限及敏感信息排除。仅低基数状态进入指标，请求/任务 ID 只用于 span/日志关联；stdout 日志保留，不接入 OTel logs exporter。配置和接入示例见 [遥测说明](observability.md)。

## 门禁、复现与发布登记

PR 和普通 main 验证运行核心浏览器测试；main/标签镜像发布工作流复用真实沙箱，完整浏览器与 importer 成功后才构建镜像；各架构镜像经过实际 smoke/维护恢复演练后才 push，六个镜像全部成功后再发布多架构 manifest。失败阻止版本发布，保留已有 Node 22/24 与单元/集成门禁。

```sh
npm run check
npm run build
npm test
npm run test:e2e
npm run test:e2e:full
node scripts/test-maintenance.mjs <maintenance-image>
```

固定 importer 和专用数据库前提、具体环境变量见 [测试说明](testing.md)，现场诊断与搜索代理见 [搜索说明](ai-web-search.md)，恢复行为见 [数据库说明](database-selection.md)。

本地日志使用 `/tmp/setdraft-rev04-*.log`，浏览器产物位于被忽略的 `test-results/` 与 `playwright-report/`，首轮完整证据另保存在 `.artifacts/rev0.4/evidence/browser-full-initial/`。生产源码归档包含配置、fixture 和 E2E，排除报告、下载、正式工作区及临时数据。

| 发布字段 | 结果 |
| --- | --- |
| 基线 commit | `da9ca6f0303bdebafb6ba31715fd905c8e8282af` |
| Rev0.4 commit / 标签 | 待提交/发布 |
| CI 运行 | 待远端执行 |
| Web / maintenance / sandbox 镜像 digest | 待远端发布 |
| 现场版本及新增诊断 | 搜索配置修复已验收；应用部署后补记 |

首个候选 commit `44f718009` 的普通 CI 通过，发布门禁两次遇到既有四次 Gen 编译复合测试的 120 秒总限时，镜像未发布。修正该测试总预算为 300 秒以容纳四次有独立沙箱期限的真实构建，再重新验收；没有移除断言或增加默认重试。最终发布登记以全部门禁通过的后续 commit 为准。

没有验证手机实际软键盘、Safari/Firefox、125%/150% 操作系统缩放、物理断电恢复或在线 OJ 导入；这些不等同于已通过的 Chromium/固定 importer/逻辑恢复证据。OSS、独立监控栈、多 Web worker 和 OTel logs exporter 留在后续范围。
