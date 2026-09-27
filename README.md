# Setdraft · 题序

算法竞赛制题工作台 · Competitive Programming Workspace

Setdraft（题序）是支持个人工作区的小团队自部署制题工作台：编辑题面、管理数据、在 GCC 16 沙箱中验证，
并下载 Hydro 题目包或 DOMjudge / Hydro 竞赛包。AI 对话独立于题目编辑。
Web 界面采用黑白配色、可收起侧栏与简洁工具栏，右上角支持中英文切换；窄屏自动切换为抽屉导航。

## 安装（Docker Compose）

服务器需要 Docker Engine、Docker Compose 插件和 Git。默认安装无需宿主机 Node.js；支持 Linux 和 macOS Docker Desktop。Windows 请在启用 Docker Desktop WSL 集成的 Linux 工作区内执行下列命令。

```bash
git clone https://github.com/Albert-Li-Sz/setdraft.git
cd setdraft
./install.sh
```

安装器生成 `.env` 与 `.env.compose`，构建 Web、沙箱和备份维护镜像，启动 Web/API、PostgreSQL 18 和 SearXNG；迁移容器负责初始化数据库表和权限。数据库及搜索端口不对宿主机开放。默认通过 `http://服务器IP:4321/` 访问，监听 `0.0.0.0:4321`，不安装反向代理、不配置 HTTPS。服务有健康检查和自动重启策略。首次安装码显示在终端及服务日志中，24 小时有效。

默认国内网络配置使用 npmmirror 和清华 Debian 源；支持 `--network global`、`--registry`、`--docker-registry`、`--download-proxy`。构建保留锁文件校验和重试，不关闭 TLS。仓库自带模型数据，构建先 telemetry 后 AI，完全使用离线模型快照。镜像构建失败会停止安装并报告错误。

```bash
./install.sh --dry-run
./upgrade.sh                  # 干净的 main 分支快进更新、构建并更新容器
./uninstall.sh                # 移除容器和网络，保留数据、配置及镜像
./scripts/setdraft-compose.sh status
./scripts/setdraft-compose.sh logs
./scripts/setdraft-compose.sh stop
./scripts/setdraft-compose.sh start
./scripts/setdraft-compose.sh backup ./my-backup
./scripts/setdraft-compose.sh restore ./my-backup
```

配置优先级：命令行 > 环境变量 > `.env` > 默认值，见 [`.env.example`](.env.example)。配置只按允许的键解析，不作为 Shell 执行。修改 `.env` 后重新执行 `./install.sh`，或使用 `node scripts/compose-config.mjs` 生成配置后执行 `docker compose --env-file .env.compose up -d --wait web`。可以用 `SETDRAFT_PORT=8080 ./install.sh` 改宿主机端口。

数据库保存在 Compose 的 `postgres-data` 卷，文件默认放在 `.setdraft/users/<userId>/`，也可设置 `SETDRAFT_WORKSPACE_ROOT`。此版本采用全新的 PostgreSQL 部署，不导入旧 SQLite 数据。首次进入网页需要重新创建管理员，其他账号及团队 AI 配置重新设置。旧数据目录不会被安装脚本自动删除；确认无需保留后可自行清理。不要同时启动原生和容器 Web 服务。

`.env.compose` 自动生成独立的数据库管理员密码、应用密码及搜索服务密钥，重新安装时保留已有值；不要在数据库卷保留的情况下更换这些密码。Web 只获得受限应用账号，数据库管理员凭据仅交给初始化和维护容器。

容器通过 Docker socket 启动独立沙箱任务，数据目录以相同绝对路径映射到容器，确保兄弟沙箱容器能读取任务文件。Docker daemon 必须位于同一宿主机；不要连接远端 Docker context。Docker socket 权限很高，仅在受信任的自部署服务器使用该部署模式。工作区应在本地磁盘上，不放网络共享盘。默认只运行一个 Web 实例，文件锁和 PostgreSQL 会话锁阻止第二个服务同时操作同一数据集。[Docker 挂载路径说明](https://docs.docker.com/engine/storage/bind-mounts/)

需要原生开发时，先准备 PostgreSQL 并在 `.env` 设置受限账号的 `SETDRAFT_DATABASE_URL`（表结构由 `migrate-cli` 使用维护账号初始化），安装 Node.js 24+ 后运行 `./install.sh --native --mode dev`；Vite 在 `127.0.0.1:5173`。原生维护工具仍为 `node scripts/hydro-local.mjs`；PowerShell 原生入口须显式使用 `-Native`。容器镜像也可通过 `docker save` / `docker load` 搬运到离线服务器；准备 `.env.compose` 后运行 `./scripts/setdraft-compose.sh start`，不会重新拉取构建依赖。

## 登录与账号

所有业务功能都需要登录。管理员在“管理员设置 → 用户管理”创建账号、启停账号、调整角色或重置密码。
创建或重置时临时密码只显示一次，用户登录后必须改密。用户名为 3–32 位字母、数字、点、下划线或短横线，
忽略大小写；密码为 15–128 个字符。系统始终保留至少一名启用的管理员。
“个人设置”保存账号语言偏好，登录后自动应用，并支持上传、预览和移除头像（PNG / JPEG / WebP，最大 5 MiB，居中裁剪）。
团队 AI、沙箱和用户管理集中在独立的“管理员设置”，普通成员无此入口。
修改密码位于“个人设置 → 账号安全”，侧栏底部提供退出登录；账号内容彼此独立，管理员也没有跨账号浏览内容的入口。

登录过期会锁定工作台并暂停保存、轮询和订阅；使用同一账号重新登录可恢复当前页面未保存的编辑。
退出或换号会清理页面中的业务数据，多标签页同步退出。尚未保存的编辑只保留在当前页面内存中，刷新页面会丢失。
退出不终止后台任务；禁用账号会撤销登录并取消未完成工作。默认全站最多 2 个沙箱任务、4 个 AI 请求，
每个用户分别最多运行 1 个；服务重启会恢复排队任务，已中断的执行可在任务页重试。

```bash
./scripts/setdraft-compose.sh account setup-code               # 未初始化时重新生成安装码
./scripts/setdraft-compose.sh account reset-password admin     # 为指定账号生成临时密码并撤销会话
```

首版不提供开放注册、邮件找回、第三方登录、协作或计费。终端恢复命令需要服务器文件访问权限。

## 直接访问与自建反向代理

默认监听 `0.0.0.0:4321`，通过 `http://服务器IP:4321` 访问；服务器防火墙需允许 TCP 4321。
IP 直连无需配置域名、证书或 `SETDRAFT_PUBLIC_ORIGIN`。登录要求 Origin 与访问 IP、端口一致，写操作仍校验 CSRF Token。

反向代理及 SSL 证书由使用者自行安装、配置和维护。将代理的上游设置为 `http://127.0.0.1:4321`（同机），
或 `http://Setdraft服务器IP:4321`（远端/容器代理），并在 Setdraft 的 `.env` 中设置浏览器实际访问的完整来源：

```dotenv
SETDRAFT_HOST="0.0.0.0"
SETDRAFT_PUBLIC_ORIGIN="https://setdraft.example.com"
```

来源也可为 HTTP、包含非默认端口；不要添加路径或末尾斜杠。填写 HTTPS 来源后启用 Secure Cookie。
需要仅允许同机代理连接时，将 `SETDRAFT_HOST` 改为 `127.0.0.1`。修改 `.env` 后运行：

```bash
./install.sh --public-origin https://setdraft.example.com
```

代理须保留浏览器原始 Host，并关闭响应缓冲以支持 SSE；不要把静态网页和 API 拆成不同浏览器来源。
同机代理可参考 [`deploy/Caddyfile.example`](deploy/Caddyfile.example)。转发 IP 仅在设置公开来源且请求来自回环地址时受信任；
远端代理默认按代理连接 IP 限流。安装脚本不占用 80/443，不修改系统代理配置，也不管理证书。

旧版原生安装器托管的 Caddy 会在执行原生停止命令时停止，原有 `deployment/` 文件仍保留；旧代理专用环境变量会从 `.env` 中移除。
`SETDRAFT_PUBLIC_ORIGIN` 会继续保留，迁移到 IP 直连时请清空它；迁移到自建代理时请核对其值。
`--domain`、`--https`、`--ssl-cert`、`--ssl-key`、`--proxy-mode`、`--caddy-archive` 等旧参数已移除。

Compose 服务可在终端关闭后继续运行，Docker 服务启动后根据重启策略恢复。
不要启用多个 API 进程或把工作区放到网络共享盘。匿名健康检查仅返回存活状态，沙箱状态需要登录。
Vite 开发模式仅在本机开放，使用 `http://127.0.0.1:5173`，不用于团队部署。

## 国内网络与离线部署

网络配置只作用于本项目，不修改全局 npm / Git 配置、宿主机 APT 源或 Docker 的 `daemon.json`：

| 参数 / 环境变量 | 用途 |
| --- | --- |
| `--network cn` / `SETDRAFT_NETWORK=cn` | 默认：npmmirror + 清华 Debian 源 |
| `--network global` | npm 官方源 + Debian 官方源；明确设置的自定义源继续优先 |
| `--registry` / `SETDRAFT_NPM_REGISTRY` | 自定义 HTTPS npm 源 |
| `SETDRAFT_DEBIAN_MIRROR` | 沙箱的 Debian 镜像站根地址，如 `https://mirrors.tuna.tsinghua.edu.cn` |
| `--docker-registry` / `SETDRAFT_DOCKER_REGISTRY` | 可访问的可信 Docker Hub 镜像仓库；填主机名和可选命名空间，不含协议、凭据或 `/library` |
| `--download-proxy` / `SETDRAFT_DOWNLOAD_PROXY` | 镜像构建中的 npm 下载代理；不自动配置 Git 或 Docker daemon |

示例（代理地址按自己的网络调整）：

```bash
./install.sh --network cn \
  --download-proxy http://host.docker.internal:7890
./upgrade.sh                          # 自动沿用 .env 中的配置
./upgrade.sh --network global         # 切换默认网络配置
```

GitHub 首次克隆发生在安装脚本运行之前；如需要代理，可使用
`git -c http.proxy=http://127.0.0.1:7890 clone https://github.com/Albert-Li-Sz/setdraft.git`。
不要在命令行填带密码的代理地址；将这类地址写入 `.env`，避免 Shell 历史记录。Unix 上脚本保存的 `.env` 权限为 `0600`。

Docker Hub 在部分国内网络下不可达。可配置自己可用的镜像仓库，脚本会同时处理 Node、Docker CLI、Python、GCC、PostgreSQL 和 SearXNG 镜像，
保留 GCC 固定摘要；管理员页面重建沙箱使用同一配置。没有适合所有网络的公共 Docker 镜像，脚本不会预置未知第三方站点。
`SETDRAFT_DOWNLOAD_PROXY` 不会自动配置 Docker 守护进程；需要代理拉取镜像时按
[Docker 守护进程代理文档](https://docs.docker.com/engine/daemon/proxy/) 单独配置，或提前 `docker load` 导入基础镜像。

## 制题流程

1. 新建题目时选择 ACM 或 OI 赛制，然后编辑 Markdown 题面和附件。
2. 手动填写或上传 `.in/.out/.ans` 测试点，或上传 C++ Gen 和逐行 `gen ...` 脚本。
   缺少输出时由标准程序生成，生成数据会排在手动数据之后。
   公开样例在“测试数据”中独立配置，不自动拼入 Markdown 题面；DOMjudge 导出到 `data/sample`，私有测试点导出到 `data/secret`。
3. 编写标准程序；可选第二标准程序、testlib Validator 和 C++ testlib Checker。默认
   Checker 是文本比较，支持 C++11/14/17/20/23/26。
4. 点击“验证并打包”，为发布包命名。后台任务记录阶段、测试点和日志；离开页面仍可在“任务”查看、
   取消或重试。完整验证和 Hydro 目录检查通过后，才生成 Hydro ZIP 和制题工程 ZIP。

题目持续自动保存，不需要先发布才能保留。题目中心支持按标题、标识和标签搜索，并按 ACM/OI 筛选。时间限制输入数字，单位 ms；内存限制输入数字，单位 m。附件支持复制 `file://文件名` 引用，上传显示弹窗进度。代码编辑器高度随视窗适配，超长代码在编辑器内部滚动。
每道题的“发布包”页签集中管理已验证版本：可重命名、下载、导出和回退。回退会恢复所选包的题面、代码、
附件、PDF、手动及生成测试数据，覆盖当前未发布修改；保留题目 ID 和所有发布历史，增加题目版本号。
发布前仍需重新验证；过期页面、损坏或不完整的源文件会阻止回退。

“复制给用户”将当前题目、代码、附件和测试数据复制到另一位启用用户的题目中心。接收方拥有独立题目 ID，
不继承历史发布包、报告、聊天或任务；双方后续修改互不影响。接收者不会获得原题目的访问权限。

已通过验证的题目可以在“竞赛列表”中组成独立竞赛，分别维护名称、题序和颜色。生成竞赛包时填写日志名称，历史包保存在对应竞赛内部。任务页按题目或竞赛分组，每次运行单独显示，点击打开日志弹窗。Hydro 竞赛包按题序包含多题；DOMjudge 竞赛包
只接受 ACM 题，包含 `problems.yaml`、气球颜色和逐题 ZIP，不包含题面。为 DOMjudge
题目单独上传 PDF 后，PDF 才会写入题目包，并支持站内弹窗预览；PDF 渲染器、字体和字符映射随应用打包，不依赖外部 CDN。OI 题目只可导出到 Hydro。

## AI 对话

管理员在管理员设置页统一提供团队 AI，普通成员只选择和使用模型，API Key 不会返回浏览器。支持三种协议：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
每套配置可保存模型名、API Key、Base URL、上下文长度和最大输出长度。对话支持 SSE
流式 Markdown、GFM、LaTeX、图片粘贴和上传；等待时显示动画，支持减少动态效果偏好；代码块可单独复制，保留缩进与换行。Enter 发送，Shift+Enter 换行。聊天记录
保存在服务器个人工作区。图片通过 multipart 上传；模型请求和 SSE 订阅分离，断线可续接且不会重复发送。

联网搜索默认开启，随对话保存开关。可填写独立搜索关键词；留空时只使用本条消息前 500 字，不发送题目快照、历史对话或附件。输入涉及私密内容时可关闭联网或指定公开关键词。默认使用 Compose 内置的 SearXNG，无需搜索 API Key；管理员也可选择 Tavily、配置密钥、测试连接和设置每日额度。搜索失败会明确提示，模型仍可继续回答；答案附可展开的真实来源列表。SearXNG 依赖上游引擎，服务器网络受限时可自行配置搜索出站代理或使用可达的 Tavily 服务。

## 数据与维护

账号、会话摘要、团队配置、题目、任务、竞赛和聊天均存入 PostgreSQL 18，业务表按用户 UUID 强制行级隔离。所有用户都使用独立的 `users/<userId>/` 文件目录，角色变更不转移内容。数据库不再依赖本地 SQLite 文件。

`backup` 先停止 Web，获取数据库独占服务锁，导出 PostgreSQL 并复制全部用户文件，生成 SHA-256 校验清单。`restore` 先验证完整性，再保存恢复前备份，恢复数据库和文件并撤销旧会话；完成后运行 `./scripts/setdraft-compose.sh start`。另外备份 `.env` 和 `.env.compose`，移动服务器时核对绝对文件路径及站点来源。备份含团队 AI 密钥，应按敏感数据保存。应用内隔离不等于磁盘加密，拥有服务器权限的运维人员仍能访问数据。发布包在题目内部管理，旧 SQLite 离线 `prune` 命令已取消。

实现细节见 [AI 联网搜索](docs/ai-web-search.md) 与 [PostgreSQL 数据存储](docs/database-selection.md)。

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
