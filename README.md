# Setdraft · 题序

算法竞赛制题工作台 · Competitive Programming Workspace

Setdraft（题序）是支持个人工作区的小团队自部署制题工作台：编辑题面、管理数据、在 GCC 16 沙箱中验证，
并下载 Hydro 题目包或 DOMjudge / Hydro 竞赛包。AI 对话独立于题目编辑。
Web 界面采用黑白配色、可收起侧栏与简洁工具栏，右上角支持中英文切换；窄屏自动切换为抽屉导航。

## 安装（Docker Compose）

服务器需要 Docker Engine、Docker Compose 插件和 Git。默认安装无需宿主机 Node.js；支持 Linux 和 macOS Docker Desktop，镜像支持 Linux amd64 / arm64。Windows 安装、升级和卸载脚本已移除。

```bash
git clone https://github.com/Albert-Li-Sz/setdraft.git
cd setdraft
./install.sh
```

安装器生成 `.env` 与 `.env.compose`，拉取官方 Web、沙箱和备份维护镜像，启动 Web/API、PostgreSQL 18 和 SearXNG；迁移容器负责初始化数据库表和权限。数据库及搜索端口不对宿主机开放。默认通过 `http://服务器IP:4321/` 访问，监听 `0.0.0.0:4321`，不安装反向代理、不配置 HTTPS。服务有健康检查和自动重启策略。首次安装码显示在终端及服务日志中，24 小时有效。

默认安装不在服务器上编译源码。镜像发布在本项目的 [GitHub Packages](https://github.com/Albert-Li-Sz?tab=packages&repo_name=setdraft)：

| 镜像 | 用途 |
| --- | --- |
| `ghcr.io/albert-li-sz/setdraft:latest` | Web、API 与数据库迁移 |
| `ghcr.io/albert-li-sz/setdraft-sandbox:latest` | GCC 16、Python、Java、testlib 沙箱 |
| `ghcr.io/albert-li-sz/setdraft-maintenance:latest` | PostgreSQL 与个人工作区备份、恢复 |

`latest` 跟随通过两种架构镜像检查的 `main` 提交；`sha-<完整提交哈希>` 固定到具体版本，`v1.2.3` Git 标签对应镜像 `1.2.3`。三个镜像使用同一版本标签。首次公开发布需要在 GitHub Packages 中把三个包的可见性设为 Public，之后无需登录即可拉取。[发布流程](.github/workflows/docker-publish.yml) 使用仓库的 `GITHUB_TOKEN`，不需要另存仓库密钥。

全部镜像成功准备后安装器才停止原 Web 服务；拉取或构建失败会直接退出，不停止当前运行的容器。

```bash
./install.sh --dry-run
./upgrade.sh                  # 干净的 main 分支快进更新、拉取并更新容器
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

需要原生开发时，先准备 PostgreSQL 并在 `.env` 设置受限账号的 `SETDRAFT_DATABASE_URL`（表结构由 `migrate-cli` 使用维护账号初始化），安装 Node.js 24+ 后运行 `./install.sh --native --mode dev`；Vite 在 `127.0.0.1:5173`。原生维护工具仍为 `node scripts/hydro-local.mjs`。容器镜像也可通过 `docker save` / `docker load` 搬运到离线服务器；准备 `.env.compose` 后运行 `./scripts/setdraft-compose.sh start`，不会重新拉取构建依赖。

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
每个用户默认分别最多运行 1 个（沙箱可配置更高的个人并发）；服务重启会恢复排队任务，已中断的执行可在任务页重试。

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

预构建镜像从 GHCR 拉取，PostgreSQL 和 SearXNG 从 Docker Hub 拉取。`--docker-registry` 仅替换 Docker Hub 来源；GHCR 受限时可在 `.env` 设置 `SETDRAFT_IMAGE_NAMESPACE` 指向已同步三个镜像的可信仓库，或通过 `SETDRAFT_WEB_IMAGE`、`SETDRAFT_SANDBOX_IMAGE`、`SETDRAFT_MAINTENANCE_IMAGE` 指定完整镜像引用。镜像拉取代理需要配置在 Docker daemon，`--download-proxy` 仅影响源码构建。

网络配置只作用于本项目，不修改全局 npm / Git 配置、宿主机 APT 源或 Docker 的 `daemon.json`：

| 参数 / 环境变量 | 用途 |
| --- | --- |
| `--network cn` / `SETDRAFT_NETWORK=cn` | 默认：npmmirror + 清华 Debian 源 |
| `--network global` | npm 官方源 + Debian 官方源；明确设置的自定义源继续优先 |
| `--registry` / `SETDRAFT_NPM_REGISTRY` | 自定义 HTTPS npm 源 |
| `SETDRAFT_DEBIAN_MIRROR` | 沙箱的 Debian 镜像站根地址，如 `https://mirrors.tuna.tsinghua.edu.cn` |
| `--docker-registry` / `SETDRAFT_DOCKER_REGISTRY` | 可访问的可信 Docker Hub 镜像仓库；填主机名和可选命名空间，不含协议、凭据或 `/library` |
| `--download-proxy` / `SETDRAFT_DOWNLOAD_PROXY` | 镜像构建中的 npm 下载代理；不自动配置 Git 或 Docker daemon |

需要修改源码或自行构建时，使用以下命令（模式保存到 `.env`，升级自动沿用）：

```bash
./install.sh --build --network cn \
  --download-proxy http://host.docker.internal:7890
./upgrade.sh                          # 自动沿用 .env 中的配置
./upgrade.sh --network global         # 切换默认网络配置
./install.sh --prebuilt               # 切回预构建镜像
```

源码构建通过 `compose.build.yaml` 显式启用，默认 `compose.yaml` 不含构建步骤。构建先 telemetry、再 AI，使用仓库中的离线模型快照；保留锁文件校验和重试，不关闭 TLS。

需要固定版本时，在 `.env` 设置 `SETDRAFT_IMAGE_TAG="sha-<完整提交哈希>"`，再执行 `./install.sh`。升级前建议备份；回退镜像不等于回退数据库，需要不兼容版本回退时使用匹配的备份。
离线服务器可提前导入三个 Setdraft 镜像及 PostgreSQL、SearXNG（没有 Node.js 时还需 Node 引导镜像），生成 `.env.compose` 后运行 `./scripts/setdraft-compose.sh start`；启动命令不拉取或构建镜像。

GitHub 首次克隆发生在安装脚本运行之前；如需要代理，可使用
`git -c http.proxy=http://127.0.0.1:7890 clone https://github.com/Albert-Li-Sz/setdraft.git`。
不要在命令行填带密码的代理地址；将这类地址写入 `.env`，避免 Shell 历史记录。Unix 上脚本保存的 `.env` 权限为 `0600`。

Docker Hub 在部分国内网络下不可达。可配置自己可用的镜像仓库，脚本会同时处理 Node、Docker CLI、Python、GCC、PostgreSQL 和 SearXNG 镜像，
保留 GCC 固定摘要；管理员页面重建沙箱使用同一配置。没有适合所有网络的公共 Docker 镜像，脚本不会预置未知第三方站点。
`SETDRAFT_DOWNLOAD_PROXY` 不会自动配置 Docker 守护进程；需要代理拉取镜像时按
[Docker 守护进程代理文档](https://docs.docker.com/engine/daemon/proxy/) 单独配置，或提前 `docker load` 导入基础镜像。

## 制题流程

完整操作说明见 [出题文档](docs/authoring-guide.md)，工作台“复制给用户”旁的“出题文档”按钮可在新标签页打开站内版本。以下是普通题流程；交互题见下节。

1. 新建题目时选择 ACM 或 OI 赛制，按“描述、输入、输出、提示、样例”分栏编辑 Markdown 题面和附件。
2. 手动填写或上传 `.in/.out/.ans` 测试点，或上传 C++ Gen 和逐行 `gen ...` 脚本。
   缺少输出时由标准程序生成，生成数据会排在手动数据之后。
   公开样例在“题面 → 样例”中配置，结构化题面、预览和 PDF 会包含样例；DOMjudge 导出到 `data/sample`，私有测试点导出到 `data/secret`。旧版完整 Markdown 保留在“描述”，可自行整理到对应栏目。
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

已通过验证的题目可以在“竞赛列表”中组成独立竞赛，分别维护名称、题序和颜色。生成竞赛包时填写日志名称，历史包保存在对应竞赛内部。任务页按题目或竞赛分组，每次运行单独显示，点击打开日志弹窗。Hydro 竞赛包按题序包含多题；DOMjudge 竞赛包只接受 ACM 题，包含 `problems.yaml`、气球颜色和逐题 ZIP。OI 题目只可导出到 Hydro。

在竞赛内开启“竞赛包附带 PDF”，配置封面副标题、署名、日期、首页 Markdown、栏目语言、题目列表和页眉页脚，保存后预览完整题册。题册来自所选发布版本而非未发布草稿。生成的竞赛包包含 `booklet.pdf` 与 `statements/A.pdf` 等单题 PDF，DOMjudge 逐题 ZIP 自动附带对应 PDF，替代旧的题目 PDF 上传入口；旧发布包不变。关闭选项则不生成新题册。PDF 直接复用 XCPC 原模板与原字体，保留首页编辑；内置 Typst、公式适配和字体，站内预览不依赖外部 CDN。题目列表属于封面，样例保留换行但不自动折行。

### 交互题

在“题目配置”开启“交互题”，ACM/OI 计分方式不变，题面切换为“描述、交互描述、提示、样例”。在“测试数据”中选择：

- **半对拍（有输入）**：上传 `.in` 或运行 Gen，输入只交给交互器；可选 testlib Validator。无需标准答案，发布时使用空答案文件。仍由交互器双向通信，不是普通 Checker 的单向对拍。
- **全交互（无输入）**：自动使用一个零字节 `.in` 和零字节答案，不注入 seed。生成器、输入校验器和原测试分组不参与运行；已有数据、程序及分组不会删除，切回有输入模式后恢复使用。

“程序与交互器”提供 C++/testlib 交互器编辑器、C++ 标准选择及可运行模板，也可导入配套标程。
有输入模板读取一个 1–1000000 的整数；无输入模板固定发送 21。标程回复两倍的数值。
模板不使用时间随机数。交互器用 `inf` 读取私有输入、`cout` 发送消息、`ouf` 读取选手回答，
用 `quitf(_ok, ...)` / `quitf(_wa, ...)` 判分；双方发送消息后必须 flush。标程支持 C++、Python、Java。
交互样例仅用于说明协议，不按普通输入输出配对执行，也不会导出为 DOMjudge 样例测试点；在“交互描述”中说明消息顺序、格式和结束条件。

验证时双方分开编译、分容器运行；选手侧不挂载私有输入、答案或交互器源码。
验证限制运行时间、输出和通信日志，异常或取消后先清理整组容器再释放任务名额。
标程及已配置的第二标准程序必须通过全部交互测试点并获得满分才能发布。
切换题型、输入模式或修改交互器后须重新验证；旧项目缺少新配置时仍按普通题处理。

Hydro 包包含 `type: interactive`、指定 C++ 语言的交互器源码和测试数据，不附加普通 Checker。
DOMjudge 仅支持 ACM，使用 `validation: custom interactive` 和 `output_validators/interactor/{build,run}`；
通过 ZIP 导入注册 executable，无需预先填写 `special_run` ID。testlib AC/WA 适配为 42/43，裁判异常保留为系统错误。
目标判题环境必须支持所选 C++ 标准；Hydro 的 C++23/26 语言可能需要管理员自行配置，C++26 仍属实验性。
不支持将交互题导出到 FPS/QDUOJ，也不新增通信题、grader 或 multi-pass。

使用与验收步骤见 [交互题说明](docs/interactive-problems.md)。本地沙箱和适配器测试不等同于在 Hydro / DOMjudge 9.0.1 上实际导入并提交的验收。

## 沙箱调度

生成、验证、竞赛导出共用一个全站调度器。默认同时运行 2 个任务，每个账号最多运行 1 个；
用户之间轮转，同一用户的任务按入队顺序执行。任务不会抢占正在运行的工作，同一题目或竞赛不能重复排队。
沙箱镜像构建会等待当前运行的任务结束后独占执行，后续任务排队；全站只接受一个未完成的镜像构建。

队列持久化在数据库中。默认每人最多 8 个、全站最多 64 个未完成任务（包括排队和运行中）；达到上限时返回 429，
不会悄悄丢弃任务。取消排队任务立即释放队列容量，运行任务在停止与清理后释放执行名额。
排队超过 30 分钟、普通任务运行超过 15 分钟或构建超过 30 分钟会失败并给出原因，支持手动重试，
重试进入队尾。任务页显示个人队列位置、等待原因、全站运行数量和排队截止时间，不估算不可靠的完成时间。

服务重启后保留排队顺序和原排队截止时间，已中断的运行需手动重试；降低队列容量不会删除已有任务，未完成任务降至新上限以下后再接受新任务。
退出账号不影响任务，禁用账号会取消其任务。排队期间题目内容发生变化时，旧任务不会使用不匹配的数据执行。

| `.env` 配置 | 默认值 | 允许范围 / 含义 |
| --- | --- | --- |
| `SETDRAFT_SANDBOX_CONCURRENCY` | `2` | 1–64，全站执行名额 |
| `SETDRAFT_SANDBOX_CONCURRENCY_PER_USER` | `1` | 1–64，每人同时执行名额，实际受全站并发限制 |
| `SETDRAFT_SANDBOX_CPUS` | `1` | 1–64，每个任务的 CPU 配额；交互运行时双方各占一半 |
| `SETDRAFT_SANDBOX_MEMORY_MB` | `2048` | 512–131072，每个任务的内存预算（MiB），不另加 swap |
| `SETDRAFT_SANDBOX_MAX_OUTSTANDING` | `64` | 1–1024，全站未完成任务上限 |
| `SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER` | `8` | 1–128，每人未完成任务上限 |
| `SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS` | `1800000` | 最长排队时间，毫秒 |
| `SETDRAFT_SANDBOX_RUN_TIMEOUT_MS` | `900000` | 普通任务最长运行时间，毫秒 |
| `SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS` | `1800000` | 镜像构建最长运行时间，毫秒 |

时间上限允许 1–86400000 毫秒；从入队或开始执行时分别计时。容器默认 1 CPU / 2 GiB，
仍禁网、只读根文件系统、无 capabilities、禁止提权。Linux 原生部署使用服务进程的非 root UID/GID；服务为 root 时容器仍使用 nobody，避免嵌套输出目录的属主导致清理失败。

交互编译串行使用任务预算，运行时交互器上限 512 MiB，选手容器为题目内存加 64 MiB（Java 加 256 MiB），
总和不能超过任务预算；预算不足会明确失败。选手的非 Java 地址空间限制及 Java 堆限制仍按题目配置执行。

高配部署可以在 `.env` 中提高并发，例如 16 核 / 32 GiB 机器可从以下设置开始压测：

```dotenv
SETDRAFT_SANDBOX_CONCURRENCY=8
SETDRAFT_SANDBOX_CONCURRENCY_PER_USER=4
SETDRAFT_SANDBOX_CPUS=1
SETDRAFT_SANDBOX_MEMORY_MB=2048
SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER=16
```

并发 × 单容器 CPU/内存配额应为 Web、PostgreSQL、搜索及系统留下余量；提高并发主要提升多个题目的吞吐，不会让单线程标程自动并行。
提高 CPU 配额可能改变多线程程序的用时，调参后应重新验证题目；容器内的题目时间/内存限制仍生效。
小内存部署可将全站并发设为 `1`。修改 `.env` 后按安装章节重新生成 Compose 配置并重启 Web，当前运行服务不会自动读取这些改动。

## AI 对话

管理员在管理员设置页统一提供团队 AI，普通成员只选择和使用模型，API Key 不会返回浏览器。支持三种协议：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
每套配置可保存模型名、API Key、Base URL、上下文长度和最大输出长度。对话支持 SSE
流式 Markdown、GFM、LaTeX、图片粘贴和上传；等待时显示动画，支持减少动态效果偏好；代码块可单独复制，保留缩进与换行。Enter 发送，Shift+Enter 换行。聊天记录
保存在服务器个人工作区。图片通过 multipart 上传；模型请求和 SSE 订阅分离，断线可续接且不会重复发送。

消息、上下文、模型输入预算及图片数量/大小/编码/格式在入队和写入图片前验证。AI 使用独立的有界队列，不占沙箱名额：
`SETDRAFT_AI_CONCURRENCY=4`（1–64），每人同时执行 1 个；`SETDRAFT_AI_MAX_OUTSTANDING=64`（1–1024）、
`SETDRAFT_AI_MAX_OUTSTANDING_PER_USER=8`（1–128），超限返回 429，配置测试也计入限额。
`SETDRAFT_AI_QUEUE_TIMEOUT_MS=1800000`、`SETDRAFT_AI_RUN_TIMEOUT_MS=900000` 分别限制排队及总执行时间（均为 1–86400000 毫秒）；连续 45 秒无内容仍会中止。
每个账号保留最近 7 天、最多 200 条已结束请求的事件回放和失败重试数据，在恢复及请求结束时清理；过期请求不可续接/重试，需重新发送。聊天记录及聊天图片不受这项临时请求清理影响。

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
项目没有官方隶属关系。竞赛 PDF 模板直接改编自
[xcpc-statement-generator](https://github.com/lihaoze123/xcpc-statement-generator)
（固定版本 `84d82230`），使用原模板和八款原字体。

## 许可与源码

集成版本采用 [AGPL-3.0](LICENSES/AGPL-3.0.txt)，原有 [MIT 声明](LICENSE) 和第三方许可保留。
详见 [COPYING.md](COPYING.md)。Web 构建前自动生成对应源码归档，侧栏和 PDF 配置的“开源与源码”
入口提供免登录下载；部署修改版本时必须同步更新并保留该源码入口。源码归档包含构建/安装脚本和锁文件，
排除部署环境文件、用户数据、依赖安装目录及生成产物；发布前应检查归档，勿把密钥放在源码目录。

字体不随模板改授 AGPL：CMU / New Computer Modern 保留 OFL / GUST 条款。
上游未提供四款方正字体的独立分发或嵌入授权文件，公开镜像、源码归档和 PDF 前需另行确认相关权利。
字体来源、校验和与许可记录见 [字体声明](packages/hydro-server/assets/xcpc/FONT-NOTICES.md)。
