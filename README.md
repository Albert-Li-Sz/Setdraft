# Setdraft · 题序

算法竞赛制题工作台 · Competitive Programming Workspace

Setdraft（题序）是桌面本地制题工作台：编辑题面、管理数据、在 GCC 16 沙箱中验证，
并下载 Hydro 题目包或 DOMjudge / Hydro 竞赛包。AI 对话独立于制题草稿。
Web 界面采用黑白配色，右上角支持中英文切换。

## 安装

环境要求：Node.js 22.19+、npm。Docker 用于生成、验证和打包；Docker 未启动时仍可安装并编辑草稿。

```bash
git clone https://github.com/Albert-Li-Sz/setdraft.git
cd setdraft
./install.sh
```

默认以生产模式安装：构建静态网页，由 API 在 `http://127.0.0.1:4321/` 同源托管。
仓库内包含已校验的模型数据快照；数据缺失或损坏时，安装脚本会尝试重新生成。
安装和升级脚本默认使用 `https://registry.npmmirror.com`；设置 `HYDRO_NPM_REGISTRY` 可覆盖 npm 镜像地址。
需要 Vite 热更新时使用 `./install.sh --mode dev`，网页在 `http://127.0.0.1:5173/`。
Docker 不可用时会告警；启动 Docker 后可在设置页检测并构建镜像。

```bash
./upgrade.sh                 # 检查干净的 main 分支后快进更新并重启
./upgrade.sh --mode dev      # 可切换模式；不指定则沿用上次模式
./uninstall.sh               # 停止服务并删除沙箱镜像，保留数据
./uninstall.sh --purge-data  # 同时删除草稿、发布包、聊天和 AI 配置
node scripts/hydro-local.mjs status
node scripts/hydro-local.mjs doctor
node scripts/hydro-local.mjs backup ./my-backup
node scripts/hydro-local.mjs restore ./my-backup
node scripts/hydro-local.mjs prune --older-than-days 90 --dry-run
```

Windows PowerShell 使用 `./install.ps1`、`./upgrade.ps1` 和 `./uninstall.ps1`；前两个支持 `-Mode dev`。
三个 Unix 脚本和三个 PowerShell 脚本都支持 dry-run。默认数据目录是 `.hydro-problem-make/`，也可用
`HYDRO_WORKSPACE_ROOT` 指定其他目录。

Setdraft 沿用原有的 `HYDRO_*` 环境变量、数据目录和内部包名，现有安装可直接升级，
草稿、聊天记录和语言偏好会继续保留。

## 制题流程

1. 新建题目时选择 ACM 或 OI 赛制，然后编辑 Markdown 题面、样例和附件。
2. 手动填写或上传 `.in/.out/.ans` 测试点，或上传 C++ Gen 和逐行 `gen ...` 脚本。
   缺少输出时由标准程序生成，生成数据会排在手动数据之后。
3. 编写标准程序；可选第二标准程序、testlib Validator 和 C++ testlib Checker。默认
   Checker 是文本比较，支持 C++11/14/17/20/23/26。
4. 点击“验证并打包”。后台任务记录阶段、测试点和日志；离开页面仍可在“任务”查看、
   取消或重试。完整验证和 Hydro 目录检查通过后，才生成 Hydro ZIP 和制题工程 ZIP。

已通过验证的题目可以组成竞赛草稿。Hydro 竞赛包按题序包含多题；DOMjudge 竞赛包
只接受 ACM 题，包含 `problems.yaml`、气球颜色和逐题 ZIP，不包含题面。为 DOMjudge
题目单独上传 PDF 后，PDF 才会写入题目包。OI 题目只可导出到 Hydro。

## AI 对话

设置页支持三种协议：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
每套配置可保存模型名、API Key、Base URL、上下文长度和最大输出长度。对话支持 SSE
流式 Markdown、GFM、LaTeX、图片粘贴和上传；Enter 发送，Shift+Enter 换行。聊天记录
只保存在本地。图片通过 multipart 上传；模型请求和 SSE 订阅分离，断线可续接且不会重复发送。

## 数据与维护

草稿、竞赛、对话、AI 配置、发布记录和任务索引保存在 `.hydro-problem-make/workspace.sqlite`。
测试文件、图片和 ZIP 按 SHA-256 存入 `blobs/`，原目录保留供回退与历史下载。
首次启动会校验并迁移旧记录，原文件暂不删除。维护前可运行 `backup`；`restore` 会保留
恢复前的数据副本。`prune` 只清理超过指定天数、未被竞赛引用且不是草稿最新版的发布包。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `packages/hydro-authoring` | Hydro 题面、目录和 ZIP 的验证与生成 |
| `packages/hydro-server` | 草稿、Docker 沙箱、发布包、竞赛包和 AI API |
| `packages/hydro-web` | 制题工作台、题面预览、记录页和 AI 对话 |
| `packages/ai`、`packages/telemetry` | AI 协议、流式事件和遥测类型 |

代码检查使用 `npm run check`。更多 API 和环境变量见各包 README。

## 致谢

感谢 [Hydro](https://github.com/hydro-dev/Hydro) 的题目格式与界面思路、
[Testlib](https://github.com/MikeMirzayanov/testlib) 的生成和校验能力，以及
[Codeforces Polygon](https://polygon.codeforces.com/) 的制题流程思路。AI 底层协议来自
[pi](https://github.com/earendil-works/pi) 的 `pi-ai` 和 telemetry 库。本项目与这些
项目没有官方隶属关系，采用 [MIT 许可](LICENSE)。
