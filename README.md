# Setdraft · 题序

## 项目介绍

Setdraft 是面向个人和小团队的自部署算法竞赛制题工作台，将题面编辑、测试数据管理、程序验证和题包导出集中在一个界面中。

- **编辑题目**：支持 Markdown、LaTeX、样例和附件，自动保存草稿并保留发布历史。
- **生成与验证**：支持多个 C++/Python Gen、多标程、验证矩阵、错误解压力测试、Validator 和 Checker，在 Docker 沙箱中运行程序，并保留运行记录与诊断日志。
- **题型与导出**：支持标准题、特判题、交互题、两轮通信题及独立 ACM/OI 计分；可导出 Hydro 题目与竞赛包、DOMjudge ACM 题目与竞赛包，并生成 PDF 题册。
- **个人工作区**：提供账号隔离、后台任务管理、浅色/深色主题和独立 AI 对话；搜索关键词由 AI 自动规划并结合来源回答，服务由管理员统一配置。

使用方法见 [出题文档](docs/authoring-guide.md) 和 [交互题说明](docs/interactive-problems.md)。

## 部署说明

准备 Git、Docker Engine 和 Docker Compose 插件；macOS 可使用 Docker Desktop。镜像支持 Linux amd64 / arm64，默认部署无需宿主机 Node.js。

```bash
git clone https://github.com/Albert-Li-Sz/Setdraft.git setdraft
cd setdraft
./install.sh
```

安装器生成 `.env` 和 `.env.compose`，拉取官方 Web、沙箱与维护镜像，并启动 Web/API、PostgreSQL 18 和 SearXNG。数据库与搜索服务仅在容器网络内开放。**`./install.sh` 默认清空已有账号、题目、对话和用户文件；已有部署升级请用 `./upgrade.sh`，保留数据重新部署请加 `--keep-data`。**

官方三类镜像统一使用版本号标签（如 `1.8.1`），`latest` 跟随通过验证的主分支和正式版本构建，预发布版本不更新 `latest`。`Rev1.8.1` 等发布标签也保留为对应版本的别名；可在 `.env` 中设置 `SETDRAFT_IMAGE_TAG` 固定版本。

安装后访问 `http://服务器IP:4321`，使用终端或服务日志中的安装码创建管理员；安装码有效期为 24 小时。其他账号由管理员创建。

默认监听 `0.0.0.0:4321`，服务器需放行对应端口。配置项见 [`.env.example`](.env.example)，修改 `.env` 后运行 `./install.sh --keep-data`。常用配置示例：

```bash
SETDRAFT_PORT=8080 ./install.sh --keep-data  # 更改访问端口
./install.sh --keep-data --build           # 从当前源码构建镜像
./install.sh --keep-data --prebuilt        # 切回官方预构建镜像
```

如需域名和 HTTPS，请自行配置反向代理，将上游指向 Setdraft，并设置浏览器实际访问的来源：

```bash
./install.sh --keep-data --public-origin https://setdraft.example.com
```

来源不含路径或末尾斜杠。代理需保留原始 Host，并关闭响应缓冲以支持 SSE；可参考 [Caddy 配置示例](deploy/Caddyfile.example)。安装脚本不配置反向代理或证书。

常用维护命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `./scripts/setdraft-compose.sh status` |
| 查看日志 | `./scripts/setdraft-compose.sh logs` |
| 保留数据升级 | `./upgrade.sh`，需处于无未提交修改的 `main` 分支 |
| 备份 | `./backup.sh`，或 `./backup.sh ../my-backup` 指定新目录 |
| 恢复备份 | `./scripts/setdraft-compose.sh restore ../my-backup` |
| 启动服务 | `./scripts/setdraft-compose.sh start` |
| 卸载并选择是否保留数据 | `./uninstall.sh`，回车默认保留 |
| 非交互卸载 | `./uninstall.sh --keep-data` 或 `./uninstall.sh --purge-data` |

备份默认保存到仓库旁的 `setdraft-backups/`，包含 PostgreSQL、全部用户文件、部署配置和 SHA-256 校验清单。备份短暂停止 Web，成功或失败后均恢复原有运行状态。备份含密钥，请妥善保管；恢复使用匹配版本，完成后手动启动服务，旧会话会失效。配置副本位于备份的 `config/`，恢复不会自动覆盖当前部署配置。

数据库保存在 `postgres-data` 卷，用户文件默认保存在 `.setdraft/users/`。Compose 卸载保留部署配置和镜像；选择保留数据后可运行 `./install.sh --keep-data` 重新启用。迁移服务器时先还原部署配置并调整路径、完成安装，再执行恢复。原生开发可为四个脚本加 `--native`；清空与备份需要同一数据库的管理员连接，备份还需要 PostgreSQL 18 客户端工具。

沙箱通过宿主机 Docker socket 启动，需使用同机 Docker daemon、本地磁盘和单个 Web 实例，并仅部署在受信任的服务器上。镜像拉取受限时，可在配置中指定可信镜像源或提前导入镜像。

## 致谢

感谢以下项目及其贡献者：

- [Hydro](https://github.com/hydro-dev/Hydro)：题目格式与界面思路。
- [Testlib](https://github.com/MikeMirzayanov/testlib)：数据生成、校验和判题支持。
- [Codeforces Polygon](https://polygon.codeforces.com/)：制题流程思路。
- [pi](https://github.com/earendil-works/pi)：AI 协议与遥测底层库。
- [xcpc-statement-generator](https://github.com/lihaoze123/xcpc-statement-generator)：竞赛 PDF 模板与原字体资源。

本项目与上述项目没有官方隶属关系。依赖来源见 [UPSTREAM.md](UPSTREAM.md)，模板与资源说明见 [资产文档](packages/hydro-server/assets/README.md)。

## 许可与源码

集成版本采用 [AGPL-3.0-only](LICENSES/AGPL-3.0.txt)。原有代码的 [MIT 声明](LICENSE) 和第三方许可保留，详见 [COPYING.md](COPYING.md)。

源码托管于 [GitHub](https://github.com/Albert-Li-Sz/Setdraft)。Web 构建时自动生成对应源码归档，用户可通过应用内“开源与源码”入口免登录下载。部署修改版本时，须同步更新并保留该源码入口；构建部署可使用 `./install.sh --keep-data --build`。

字体遵循各自的许可，不随模板改授 AGPL。其中四款方正字体的分发与嵌入授权需另行确认，详见 [字体声明](packages/hydro-server/assets/xcpc/FONT-NOTICES.md)。
