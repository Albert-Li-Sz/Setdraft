# Hydro Problem Make

一个面向桌面的本地 [Hydro](https://github.com/hydro-dev/Hydro) 制题工作台。它基于 [Pi 仓库](https://github.com/earendil-works/pi) 二次开发，但**制题流程不使用 Pi Agent**；只有独立的 AI 对话使用 `pi-ai`，且不会自动修改题目草稿。

## 快速开始

需要 Git、Node.js 22.19+、npm 和已启动的 Docker。安装脚本支持 macOS、Linux 与 Windows WSL。

```bash
git clone https://github.com/Albert-Li-Sz/Hydro-Problem-Maker-Agent.git
cd Hydro-Problem-Maker-Agent
./install.sh
```

脚本安装依赖、构建 GCC 16.2 沙箱并启动本地服务。打开 **http://127.0.0.1:5173/**；API 默认位于 `127.0.0.1:4321`。

## 制题流程

1. 新建题目前选择 **ACM** 或 **OI** 赛制；编写 Markdown 题面、公开样例，并按需添加附件。赛制在创建后固定。
2. 手动填写或上传 `.in/.out/.ans` 测试数据；也可上传 C++ Gen 源码，用每行一条 `gen ...` 命令批量生成。未提供的答案由标准程序生成。
3. 填写标准程序；每题默认使用文本比对 Checker，也可改为自定义 C++ testlib SPJ。第二标准程序和 testlib 输入校验器可选。C++ 可选 C++11/14/17/20/23 与实验性 C++26。
4. 点击“验证并打包”。通过本地沙箱检查后，可下载 Hydro 题目 ZIP 和包含源码、数据与报告的制题工程 ZIP。ACM 题还可导出 DOMjudge、FPS 和 QDUOJ 单题格式；DOMjudge 包默认没有题面，手动上传 PDF 后才附带 `problem.pdf`。

“竞赛”页面按题序组合已验证的题目版本。Hydro 多题包可包含 ACM 与 OI 题，提供逐题 ZIP 和顺序清单；DOMjudge 竞赛包只接受 ACM 题，提供 `problems.yaml`、气球颜色和逐题 ZIP。竞赛时间、队伍等信息仍在目标平台配置。DOMjudge 按[官方导入流程](https://www.domjudge.org/docs/manual/8.3/import.html)先导入 `problems.yaml`，再上传各题 ZIP。当前不支持交互题或提交答案题；真实 Hydro 导入测试是可选的独立步骤。详见 [服务端说明](packages/hydro-server/README.md)。

AI 对话支持多组 API / 模型配置、流式 Markdown 与图片，可选择附带当前题面和标程的只读快照；聊天记录保存在本地。

## 更新与卸载

```bash
./upgrade.sh                  # 在干净的 main 分支快进更新并重启
./uninstall.sh                # 停止服务并删除沙箱镜像，保留题目与配置
node scripts/hydro-local.mjs status
```

也可用 `node scripts/hydro-local.mjs start` 或 `stop` 单独管理服务。三个脚本均支持 `--dry-run`。默认数据目录为 `.hydro-problem-make/`；`./uninstall.sh --purge-data` 才会永久删除草稿、发布包、聊天记录和 AI 配置。升级不会覆盖未提交改动。手动开发方式见 [网页说明](packages/hydro-web/README.md)；代码检查使用 `npm run check`。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| [`packages/hydro-web`](packages/hydro-web) | 制题工作台与 AI 对话网页 |
| [`packages/hydro-server`](packages/hydro-server) | 草稿、Docker 验证、发布包与对话接口 |
| [`packages/hydro-authoring`](packages/hydro-authoring) | Hydro 格式验证与 ZIP 生成 |

## 致谢

感谢 [Hydro](https://github.com/hydro-dev/Hydro) 提供题目格式参考、[Testlib](https://github.com/MikeMirzayanov/testlib) 提供生成与校验能力、[Codeforces Polygon](https://polygon.codeforces.com/) 提供制题流程思路，以及 [Pi](https://github.com/earendil-works/pi) 提供代码基础与 `pi-ai`。本项目的前端独立实现，与这些项目没有官方隶属关系。上游基线见 [UPSTREAM.md](UPSTREAM.md)，随沙箱附带的 Testlib 许可见 [LICENSE](packages/hydro-server/sandbox/testlib/LICENSE)。

本项目采用 [MIT 许可](LICENSE)。
