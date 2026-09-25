# Hydro Problem Make

Hydro Problem Make 是面向桌面的本地制题工作台：编辑题面、管理测试数据、运行 GCC 16
沙箱验证，并下载可导入 Hydro 的题目包。它还提供独立的 AI 对话页面；AI 只能回答
问题，不会修改草稿，也没有 Pi Agent 的工具运行时。

## 安装

环境要求：Node.js 22.19+、npm、Docker（Linux、macOS 或 Windows WSL）。

```bash
git clone https://github.com/Albert-Li-Sz/Hydro-Problem-Maker-Agent.git
cd Hydro-Problem-Maker-Agent
./install.sh
```

安装脚本执行 `npm ci --ignore-scripts`、构建 GCC 16.2 沙箱并启动服务。网页地址是
`http://127.0.0.1:5173/`，API 地址是 `http://127.0.0.1:4321/`。

```bash
./upgrade.sh                 # 检查干净的 main 分支后快进更新并重启
./uninstall.sh               # 停止服务并删除沙箱镜像，保留数据
./uninstall.sh --purge-data  # 同时删除草稿、发布包、聊天和 AI 配置
node scripts/hydro-local.mjs status
```

Windows PowerShell 使用 `./install.ps1`、`./upgrade.ps1` 和 `./uninstall.ps1`。
三个 Unix 脚本和三个 PowerShell 脚本都支持 dry-run。默认数据目录是 `.hydro-problem-make/`，也可用
`HYDRO_WORKSPACE_ROOT` 指定其他目录。

## 制题流程

1. 新建题目时选择 ACM 或 OI 赛制，然后编辑 Markdown 题面、样例和附件。
2. 手动填写或上传 `.in/.out/.ans` 测试点，或上传 C++ Gen 和逐行 `gen ...` 脚本。
   缺少输出时由标准程序生成，生成数据会排在手动数据之后。
3. 编写标准程序；可选第二标准程序、testlib Validator 和 C++ testlib Checker。默认
   Checker 是文本比较，支持 C++11/14/17/20/23/26。
4. 点击“验证并打包”。沙箱会编译、运行、复现数据并检查 Hydro 目录，全部通过后才
   生成 Hydro ZIP 和包含源码、数据、参数及报告的制题工程 ZIP。

已通过验证的题目可以组成竞赛草稿。Hydro 竞赛包按题序包含多题；DOMjudge 竞赛包
只接受 ACM 题，包含 `problems.yaml`、气球颜色和逐题 ZIP，不包含题面。为 DOMjudge
题目单独上传 PDF 后，PDF 才会写入题目包。OI 题目只可导出到 Hydro。

## AI 对话

设置页支持三种协议：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
每套配置可保存模型名、API Key、Base URL、上下文长度和最大输出长度。对话支持 SSE
流式 Markdown、GFM、LaTeX、图片粘贴和上传；Enter 发送，Shift+Enter 换行。聊天记录
只保存在本地。

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
