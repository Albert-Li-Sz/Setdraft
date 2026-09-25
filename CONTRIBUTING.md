# 贡献指南

Hydro Problem Make 是一个本地制题工作台。贡献应围绕以下包展开：

- `packages/hydro-authoring`：Hydro 目录、题面和 ZIP 的生成与检查。
- `packages/hydro-server`：草稿、沙箱验证、发布包、竞赛包和 AI 对话 API。
- `packages/hydro-web`：桌面网页工作台。
- `packages/ai`、`packages/telemetry`：AI 对话所需的底层库。

提交改动前运行 `npm run check`，并为行为变化运行对应的定向测试。AI 测试使用
faux provider，不要提交真实密钥、生成的数据目录、构建产物或本地工作区内容。

直接依赖必须使用精确版本。TypeScript 源码使用可由 Node 直接擦除的语法，所有相对
导入保留 `.ts` 扩展名。新增 API 时同步更新包 README 和相关测试。

提交前检查 `git status`，只暂存本次改动的路径。不要使用 `git add .`、`git add -A`、
强制推送或跳过检查的提交。
