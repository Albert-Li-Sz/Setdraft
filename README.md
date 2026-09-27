# Setdraft · 题序

算法竞赛制题工作台 · Competitive Programming Workspace

Setdraft（题序）是支持个人工作区的小团队自部署制题工作台：编辑题面、管理数据、在 GCC 16 沙箱中验证，
并下载 Hydro 题目包或 DOMjudge / Hydro 竞赛包。AI 对话独立于题目编辑。
Web 界面采用黑白配色、可收起侧栏与简洁工具栏，右上角支持中英文切换；窄屏自动切换为抽屉导航。

## 安装

环境要求：Node.js 22.19+、npm。Docker 用于生成、验证和打包；Docker 未启动时仍可安装并编辑题目。

```bash
git clone https://github.com/Albert-Li-Sz/setdraft.git
cd setdraft
./install.sh
```

默认以生产模式安装：构建静态网页，由 API 在 `http://127.0.0.1:4321/` 同源托管。
仓库内包含已校验的模型数据快照；数据缺失或损坏时，安装脚本会尝试重新生成。
安装和升级脚本默认使用 `https://registry.npmmirror.com`；设置 `HYDRO_NPM_REGISTRY` 可覆盖 npm 镜像地址。
需要 Vite 热更新时使用 `./install.sh --mode dev`，网页在 `http://127.0.0.1:5173/`。
Docker 不可用时会告警；启动 Docker 后管理员可在管理员设置页检测并构建镜像。
首次启动在终端显示一次性安装码（24 小时有效）；打开网页，输入安装码并设置首位管理员的用户名与密码。
升级前的所有内容会固定归属首位管理员，原资源 ID 和下载地址保持不变。

```bash
./upgrade.sh                 # 检查干净的 main 分支后快进更新并重启
./upgrade.sh --mode dev      # 可切换模式；不指定则沿用上次模式
./uninstall.sh               # 停止服务并删除沙箱镜像，保留数据
./uninstall.sh --purge-data  # 同时删除题目、发布包、聊天和 AI 配置
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
题目、聊天记录和语言偏好会继续保留。

## 登录与账号

所有业务功能都需要登录。管理员在“管理员设置 → 用户管理”创建账号、启停账号、调整角色或重置密码。
创建或重置时临时密码只显示一次，用户登录后必须改密。用户名为 3–32 位字母、数字、点、下划线或短横线，
忽略大小写；密码为 15–128 个字符。系统始终保留至少一名启用的管理员。
“个人设置”保存账号语言偏好，登录后自动应用，并支持上传、预览和移除头像（PNG / JPEG / WebP，最大 5 MiB，居中裁剪）。
团队 AI、沙箱和用户管理集中在独立的“管理员设置”，普通成员无此入口。
侧栏底部提供修改密码和退出；账号内容彼此独立，管理员也没有跨账号浏览内容的入口。

登录过期会锁定工作台并暂停保存、轮询和订阅；使用同一账号重新登录可恢复当前页面未保存的编辑。
退出或换号会清理页面中的业务数据，多标签页同步退出。尚未保存的编辑只保留在当前页面内存中，刷新页面会丢失。
退出不终止后台任务；禁用账号会撤销登录并取消未完成工作。默认全站最多 2 个沙箱任务、4 个 AI 请求，
每个用户分别最多运行 1 个；服务重启会恢复排队任务，已中断的执行可在任务页重试。

```bash
node scripts/hydro-local.mjs account setup-code               # 未初始化时重新生成安装码
node scripts/hydro-local.mjs account reset-password admin     # 为指定账号生成临时密码并撤销会话
```

首版不提供开放注册、邮件找回、第三方登录、协作或计费。终端恢复命令需要服务器文件访问权限。

## 团队 HTTPS 部署

保持 API 仅监听 `127.0.0.1:4321`，通过同机 Caddy 提供 HTTPS。将域名指向服务器，使用
[`deploy/Caddyfile.example`](deploy/Caddyfile.example)，并在**每次启动服务的环境**中配置：

```bash
export HYDRO_PUBLIC_ORIGIN=https://setdraft.example.com
node scripts/hydro-local.mjs start --mode production
```

来源必须与浏览器地址完全一致，不含路径或末尾斜杠。Caddy 保留原始 Host，并覆盖转发 IP；应用只在同机 HTTPS
代理场景信任转发信息。不要直接暴露 4321、启用多个 API 进程或把工作区放到网络共享盘。
本机开发可省略该变量，通过 Vite 的同源 `/api` 代理访问。匿名健康检查只返回服务存活状态；沙箱状态需要登录。

## 制题流程

1. 新建题目时选择 ACM 或 OI 赛制，然后编辑 Markdown 题面、样例和附件。
2. 手动填写或上传 `.in/.out/.ans` 测试点，或上传 C++ Gen 和逐行 `gen ...` 脚本。
   缺少输出时由标准程序生成，生成数据会排在手动数据之后。
3. 编写标准程序；可选第二标准程序、testlib Validator 和 C++ testlib Checker。默认
   Checker 是文本比较，支持 C++11/14/17/20/23/26。
4. 点击“验证并打包”，为发布包命名。后台任务记录阶段、测试点和日志；离开页面仍可在“任务”查看、
   取消或重试。完整验证和 Hydro 目录检查通过后，才生成 Hydro ZIP 和制题工程 ZIP。

题目持续自动保存，不需要先发布才能保留。题目中心支持按标题、标识和标签搜索。
每道题的“发布包”页签集中管理已验证版本：可重命名、下载、导出和回退。回退会恢复所选包的题面、代码、
附件、PDF、手动及生成测试数据，覆盖当前未发布修改；保留题目 ID 和所有发布历史，增加题目版本号。
发布前仍需重新验证；过期页面、损坏或不完整的源文件会阻止回退。

“复制给用户”将当前题目、代码、附件和测试数据复制到另一位启用用户的题目中心。接收方拥有独立题目 ID，
不继承历史发布包、报告、聊天或任务；双方后续修改互不影响。接收者不会获得原题目的访问权限。

已通过验证的题目可以组成竞赛草稿。Hydro 竞赛包按题序包含多题；DOMjudge 竞赛包
只接受 ACM 题，包含 `problems.yaml`、气球颜色和逐题 ZIP，不包含题面。为 DOMjudge
题目单独上传 PDF 后，PDF 才会写入题目包。OI 题目只可导出到 Hydro。

## AI 对话

管理员在管理员设置页统一提供团队 AI，普通成员只选择和使用模型，API Key 不会返回浏览器。支持三种协议：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
每套配置可保存模型名、API Key、Base URL、上下文长度和最大输出长度。对话支持 SSE
流式 Markdown、GFM、LaTeX、图片粘贴和上传；Enter 发送，Shift+Enter 换行。聊天记录
只保存在本地。图片通过 multipart 上传；模型请求和 SSE 订阅分离，断线可续接且不会重复发送。

## 数据与维护

身份、会话摘要、账号操作日志及团队 AI 配置保存在 `.hydro-problem-make/identity.sqlite`。
首位管理员沿用根目录的 `workspace.sqlite` 和原文件；新增用户各自使用 `users/<userId>/workspace.sqlite` 与独立文件目录。
调整管理员角色不会转移旧内容。旧 AI 配置只导入一次；迁移可重复执行，不删除原数据。
测试文件、图片和 ZIP 按 SHA-256 存入 `blobs/`，原目录保留供回退与历史下载。
首次启动会校验并迁移旧记录，原文件暂不删除。维护前可运行 `backup`；`restore` 会保留
恢复前的数据副本，并撤销备份中的全部旧会话。备份覆盖身份库、所有用户工作区和历史文件；维护工具会先停止托管服务，
若存在直接启动的服务则拒绝继续。完成后需运行 `node scripts/hydro-local.mjs start` 重启。
不要只复制单个 SQLite 文件；备份也含团队 AI 密钥，需按敏感数据保管。应用内隔离不是磁盘加密，
具有服务器文件权限的运维人员仍可访问数据。
`prune` 只清理超过指定天数、未被竞赛引用且不是题目最新版的发布包。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `packages/hydro-authoring` | Hydro 题面、目录和 ZIP 的验证与生成 |
| `packages/hydro-server` | 题目、Docker 沙箱、发布包、竞赛包和 AI API |
| `packages/hydro-web` | 制题工作台、题面预览、题目中心和 AI 对话 |
| `packages/ai`、`packages/telemetry` | AI 协议、流式事件和遥测类型 |

代码检查使用 `npm run check`。更多 API 和环境变量见各包 README。

## 致谢

感谢 [Hydro](https://github.com/hydro-dev/Hydro) 的题目格式与界面思路、
[Testlib](https://github.com/MikeMirzayanov/testlib) 的生成和校验能力，以及
[Codeforces Polygon](https://polygon.codeforces.com/) 的制题流程思路。AI 底层协议来自
[pi](https://github.com/earendil-works/pi) 的 `pi-ai` 和 telemetry 库。本项目与这些
项目没有官方隶属关系，采用 [MIT 许可](LICENSE)。
