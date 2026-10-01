# 浏览器测试与 Markdown 回归

## 本地运行

需要 Node 22.19+、Docker，以及 Playwright 固定版本配套的 Chromium。AI 始终使用注入的 faux 客户端。测试不会使用正式工作区或配置文件。

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run build
npm run test:e2e
```

首次运行自动启动固定 digest 的临时 PostgreSQL。也可以提供 `SETDRAFT_E2E_DATABASE_URL`，但必须指向专用测试数据库，并允许创建 schema 和测试角色。每个场景创建随机 schema 前缀、受限应用角色、临时工作区和新账号；结束时只删除自身资源。服务端使用生产构建和真实 API。重启和会话过期通过测试进程 IPC 控制，没有生产测试控制接口。

完整测试需要真实沙箱镜像：

```sh
docker build -t setdraft/sandbox:local packages/hydro-server/sandbox
npm run test:e2e:full
# 只调试某个场景
npm run test:e2e:full -- --grep 'generates, validates'
```

可用 `SETDRAFT_SANDBOX_IMAGE` 选择已构建的镜像。默认 1 worker、0 重试；固定浏览器版本由精确固定的 `@playwright/test` 和 lockfile 决定。等待依赖页面断言、API 保存结果和 SSE 阶段事件，不使用固定休眠等待业务完成。

核心测试覆盖安装、登录、会话恢复、多标签退出、自动保存、刷新及重启恢复、快速切题、账号隔离、附件预览、聊天流式展示/失败重试/取消、文档搜索，以及真实 PDF 预览和下载。下载基线来自仓库固定 A+B 样例包；该 fixture 的发布记录只用于 UI 契约，不代表真实沙箱验收。

完整测试另外执行真实生成器、validator、C++ 标程、Python 第二标程及 checker，发布 A+B，检查 Hydro/DOMjudge ZIP 的条目和数据，再导出带 PDF 的竞赛包。编译失败不会生成发布包；取消发生在真实生成器编译完成后，修正源码后可重试。PDF 检查文字，并生成完整页面 PNG，浏览器也渲染实际预览页面。

失败保留 `test-results/` 的截图、trace、脱敏服务日志和 `playwright-report/` HTML 报告；PDF 文本、下载及渲染页面也保存在测试输出目录。这些目录已被 Git、镜像构建和源码归档排除。trace 包含测试账号及 faux 请求信息，只使用专用测试数据。

```sh
npx playwright show-report
npx playwright show-trace test-results/<scenario>/trace.zip
```

## CI 门禁

| 工作流 | 浏览器层级 |
| --- | --- |
| PR / 普通 main CI | Node 24 跑核心浏览器测试 |
| main / 发布标签 / 手动镜像发布 | 复用沙箱构建，跑完整浏览器测试，成功后才发布镜像 |

可复用 `verify.yml` 的 `full-e2e` 默认为 false。完整流程已包含核心用例，因此发布验证中不重复跑核心浏览器 job。已有 Node 22/24 单元、集成和沙箱门禁保持启用。失败证据保存 14 天。Vitest 明确排除 `e2e/`；Playwright 只发现 `e2e/*.spec.mjs`。参照 [Playwright 官方 CI 指南](https://playwright.dev/docs/ci)。

## Rev0.4 回归与真实边界

核心浏览器测试新增重新登录后的 revision/测试点/竞赛目录刷新、迟到题目与对话打开/创建回调、读取途中导航返回、长聊天滚动位置及代码/表格局部滚动。完整布局矩阵覆盖 320–3840 CSS 像素、DPR 1/2、中英文、导航展开/收起和低高度窗口；桌面步骤页共用高度，运行状态与编辑框底边差值不超过 2px。分隔条同时测试键盘、拖动和双击恢复 50:50。

完整服务端测试使用真实 PostgreSQL 验证回退/复制、文件冲突、竞赛引用与终态持久化竞态，使用真实 Docker 验证 CLI 异常退出、取消、超时和清理责任。判题协议的预期满分/零分/部分分/裁判故障由独立 fixture 指定。原生 SPJ 对 81 组实际输出与 bundled testlib 做差分。

FPS 导入契约执行固定 QDUOJ 上游 commit `df873278ab1b29510aa3a0979677d7aa9a53ca0e` 的 parser、serializer 和测试点保存逻辑；下载脚本校验每个文件的 SHA-256。需 Python 3.12：

```sh
node scripts/fetch-qduoj-contract.mjs
python3.12 -m venv .artifacts/qduoj-python
.artifacts/qduoj-python/bin/pip install -r scripts/qduoj-contract-requirements.txt
SETDRAFT_REQUIRE_IMPORTER=1 \
SETDRAFT_QDUOJ_CONTRACT_ROOT="$PWD/.artifacts/qduoj-contract" \
SETDRAFT_QDUOJ_CONTRACT_PYTHON="$PWD/.artifacts/qduoj-python/bin/python" \
npm run test --workspace=@setdraft/server
```

CI 的沙箱门禁强制执行此导入契约。此检查证明固定导入器接受产物，在线 OJ 的账号、部署或裁判配置另属部署验收。

维护镜像发布前执行真实恢复演练：专用 PostgreSQL、业务角色、缺失 blob 的损坏现场、健康目标恢复、会话撤销、损坏目标拒绝、错误数据库预检及运行中服务锁。原生维护入口运行在没有 Docker socket 的镜像内。

```sh
node scripts/test-maintenance.mjs <maintenance-image>
sh scripts/smoke-image.sh web <web-image>
sh scripts/smoke-image.sh maintenance <maintenance-image>
sh scripts/smoke-image.sh sandbox <sandbox-image>
```

## 共享 Markdown 层

`@setdraft/authoring/markdown` 提供 `MarkdownProfile`、解析、remark 配置、AST 遍历、引用解析、安全 URL、诊断和文档分章。`statement` 与 `chat` 使用 GFM 和数学公式，`guide` 使用 GFM。网页由共享 `MarkdownView` 包装 ReactMarkdown，PDF 保留 cmarker/Typst。

附件目标先经 CommonMark 解析解码；`file://` 大小写不敏感，查询与片段不参与定位，仍使用平面 ASCII 文件名约束。引用定义按整篇文档收集，首个定义优先，题面各栏目共享定义。PDF 只按源码范围改写渲染用文本；保存内容和题包题面保留原文。文档按顶层二级标题分章，代码块中的标题不进入导航，各章保留整篇引用与脚注定义。

复杂度限制为 30000 节点、80 层。浏览器处理失败时显示转义原文和短提示；校验报告使用 `MARKDOWN_COMPLEXITY_LIMIT`、`MARKDOWN_PROCESSING_FAILED`、`INVALID_ATTACHMENT_REFERENCE`、`MISSING_ATTACHMENT`、`UNSAFE_MARKDOWN_URL` 和源码位置。共享契约样例在 `fixtures/markdown/`，供作者层、网页和 PDF 测试共同使用。

```sh
npm run check
node node_modules/vitest/dist/cli.js --run packages/hydro-authoring/test/markdown-layer.test.ts packages/hydro-web/test/problem-preview.test.tsx
cd packages/hydro-server
node ../../scripts/test-server.mjs test/pdf-markdown.test.ts test/observability.test.ts
```

浏览器 smoke 构建检查共享 Markdown 不引入 Node 或 OTel SDK。源码归档包括浏览器配置、fixture 和测试。模型采用 [unified 的解析、转换、输出流程](https://unifiedjs.com/learn/guide/introduction-to-unified/)。
