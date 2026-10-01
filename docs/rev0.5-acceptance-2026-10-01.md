# Setdraft Rev0.5 修复与验收记录

基线：Rev0.4 `da0a0700523bb7b9d0dfae43e4679a90b83e70bc`。本版针对 2026-10-01 的第三方审计修复 B01–B04，根项目版本为 `0.0.5`，发布标签为 `Rev0.5`。

## 修复结果

| 编号 | 触发条件与修复后的行为 | 回归证据 |
| --- | --- | --- |
| B01 | `points 0.5 rescore(100)` 保持 50 分，不成为 AC；显式覆盖分数必须是由 ASCII 空白或消息首尾分隔的独立 `score(...)` token。TS、Python、C locale 的 awk 共用该规则，状态词与数字也使用相同 ASCII 词法。 | 三语言共享 fixture；真实 Docker/testlib checker 的正确值、错误格式、错误数值；中文前缀、Unicode 空白/数字、多行、多个分数、边界分数。 |
| B02 | 执行入口拥有 controller 和计算槽的完整生命周期，遥测元数据读取失败进入终态结算；结算待提交的 queued 任务不再被重新执行，后续任务仍能调度。分配计算槽后、登记 controller 前的读取失败也归还计算槽。 | 专用 PostgreSQL、真实调度器，入口读取故障、running 事件真实 SQL 回滚、终态写入故障及恢复、业务仅执行一次、后续任务继续运行。 |
| B03 | 题目发布目录和历史包读取不再因竞赛变更而丢弃；新建、更新、删除结束后重新读取竞赛列表，失败的变更也触发替代读取。 | 真实 Chromium 与生产构建：延迟三个初始 GET，分别创建成功和失败，旧竞赛、新竞赛、已有题目和历史包保持可见。 |
| B04 | 在整个题面的共享 AST 中收集 first-wins 脚注定义，按首次引用生成题目内映射。各栏目使用原生 Typst 脚注或对既有脚注的引用，不复制页脚；不同题目有独立标签命名空间，编号从 1 开始。 | 实际 Typst/WASM 编译单题 PDF 和题册，检查正文引用、重复引用、重复定义、中文标识及内容；既有模板布局、图片、链接和安全测试继续通过。 |

原始题面保持不变。新增的 `remark-stringify` 依赖固定为 `11.0.0`，仅用于序列化从共享 AST 提取的脚注内容。PostgreSQL、本地存储、网络监听及部署拓扑沿用已有配置。

## 历史导出处理

导出契约由 1 升为 2。当前单题导出文件使用 `domjudge.v2.zip`，旧缓存 `domjudge.v1.zip` 不作为当前导出返回；需要重新点击导出。FPS/QDUOJ 共用该文件命名契约，也会重新生成对应的 v2 导出。

已经下载或已经导入目标 OJ 的旧 ZIP 不会自动改变。历史竞赛包是不可变快照：含自定义 checker 或 interactor 的旧 DOMjudge 包应重新生成并重新导入，不能仅升级 Web 镜像后继续使用旧适配器。

## 本地验证

先在 Rev0.4 上运行新增回归，捕获真实 checker 错误 AC、入口失败仍 queued、PDF 保留原始引用，以及浏览器创建成功后旧竞赛缺失；随后修复并运行以下检查。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过：格式、精确依赖、运行时依赖、导入/入口图、模块边界、根与前端 TypeScript、浏览器产物检查。 |
| `npm run build` | 通过：生产构建及离线模型快照检查。 |
| 服务端定向回归，8 个文件 | 63 项通过；使用专用 PostgreSQL 和现有真实 Docker 沙箱，包括 export v1 缓存拒绝用例。 |
| 前端预览/PDF 编辑器 | 11 项通过。 |
| 新增 Chromium 竞赛加载回归 | 2 项通过，0 重试。 |
| Chromium 认证恢复回归 | 1 项通过；连同两个新增竞态场景共 3 项通过。 |
| 发布门禁与依赖检查脚本 | 10 项通过。 |
| PDF 视觉复核 | 实际生成中文重复引用的单题 PDF 与两题题册，复核正文上标、页脚、跨题命名空间与编号。 |

服务端命令（在 `packages/hydro-server` 下）：

```sh
node ../../scripts/test-server.mjs test/checker-protocol.test.ts test/task-scheduling.test.ts test/pdf-markdown.test.ts test/tasks.test.ts test/contest-pdf-template.test.ts test/contest-statement-export.test.ts test/terminal-settlements.test.ts test/release-ownership.test.ts
```

浏览器命令（仓库根目录）：

```sh
node scripts/test-e2e.mjs e2e/contest-loading.spec.mjs
```

本地定向通过不等于旧 25 项全部完成真实环境验收。本版沿用 `.github/workflows/docker-publish.yml`：完整 Node 22/24、Linux 沙箱、完整浏览器门禁通过后，分别构建并 smoke test Web、maintenance、sandbox 的 amd64/arm64 镜像，再推送多架构 manifest。远端运行、最终发布提交及镜像 digest 记录在 Rev0.5 的 GitHub Release 中；在发布完成前不将本地结果描述为镜像已经发布。
