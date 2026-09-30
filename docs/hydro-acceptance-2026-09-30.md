# Hydro 实例交互题验收：2026-09-30

在用户提供的 [Hydro 实例](https://icpc.njxzu.cn/) 上实际导入题目 ZIP 并提交程序。网页标示版本为 Hydro v5.0.7，评测器具体版本未独立确认。首轮使用 Setdraft 源码版本 `a6a96541bcd991266032e94662e39e4f301aec26`；`auto` 补测使用该版本基础上的导出修复，测试时尚未提交。

结论：交互题导入、双向通信、正确/错误/CPU 超时判定、OI 子任务计分和指定私有文件路径探针通过。原包的交互器语言 ID 不匹配问题已通过统一 `auto` 修复，两个新包未经手动适配直接导入，七次提交结果符合预期。裁判异常和不 flush 的判定仍不满足原验收要求，因此不能标记完整平台验收通过。DOMjudge 9.0.1 尚未进行真实导入验收。

## 范围与题目

共创建了五个属于测试账号的隐藏题目（首轮三个，`auto` 补测两个），没有修改其他人的题目或站点/判题机全局配置。保留题目及提交，便于复核。

| 题目 | 题目 ID | 配置 |
| --- | --- | --- |
| [交互翻倍](https://icpc.njxzu.cn/p/786) | 786 | 无输入：一个零字节 `.in` 和一个零字节 `.out`，100 分 |
| [有输入交互与 OI 分组](https://icpc.njxzu.cn/p/SDTESTI20260930) | 787 / SDTESTI20260930 | 私有输入 `21\n`、`7\n`，答案均零字节，两个独立子任务 30/70 分 |
| [裁判异常](https://icpc.njxzu.cn/p/SDTESTF20260930) | 788 / SDTESTF20260930 | 独立异常探针：回答 -777 触发 `abort()`，-778 触发 testlib `_fail` |
| [auto 全空交互](https://icpc.njxzu.cn/p/SDTESTAUTOE20260930) | 789 / SDTESTAUTOE20260930 | 新导出包，`lang: auto`，输入与答案均零字节，100 分 |
| [auto 有输入交互](https://icpc.njxzu.cn/p/SDTESTAUTOI20260930) | 790 / SDTESTAUTOI20260930 | 新导出包，`lang: auto`，私有输入与空答案，30/70 分 |

首轮无输入题使用既有、已由 Setdraft 完整验证并发布的 Hydro ZIP；其余四个诊断题通过 `buildHydroProblemArchive` 导出函数生成，未另走服务器发布流水线。所有题目都被 Hydro 识别为 `interactive`；配置的 2 秒、256 MiB、测试点数量及子任务分值正确。

## 包哈希与语言适配

| 原始包 | SHA-256 |
| --- | --- |
| 无输入发布包 | `acfa5ec8e904b462734d7e531bf9244955fe8ba178ef5e0fb9dccccda8b290f0` |
| 有输入诊断包 | `c712964757c4eb0ab013fbe844ca3d18d0557f98572cf76a0f407033b239c84f` |
| 裁判异常诊断包 | `a5f7351229ed24668b0ab7d2086f7dc5fb731b4b184e5d7677d82f9d25234811` |

原始包指定 `interactor.lang: cc.cc17`。此站的编译配置提供 `cc`（C++14）、`cc.cc20o2` 和 `cc.cc23o2`，未提供 `cc.cc17`。直接提交正确解得到 [Format Error](https://icpc.njxzu.cn/record/6abcc9786ded9b2cf44451e1)：`Unknown interactor language: cc.cc17.`

随后只在测试题的 `config.yaml` 中把交互器语言改为 `cc.cc20o2`；选手程序也使用该语言。源码、输入、空答案、时限、内存和评分未改变。异常诊断题直接导入带相同语言适配的包。下面的判定均在这项适配后取得，不代表原始包在此站可以无需配置直接使用。

## 首轮实际提交结果

| 题目 | 程序 | 实际判定 | 分数 | 提交 |
| --- | --- | --- | --- | --- |
| 无输入 | 正确解并 flush | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abcca1f6ded9b2cf44451ec) |
| 无输入 | 答案加一 | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abcca366ded9b2cf44451f9) |
| 无输入 | CPU 忙等 | TLE | 0 | [记录](https://icpc.njxzu.cn/record/6abccb1f6ded9b2cf444520e) |
| 无输入 | 不 flush 后等待输入 | RE | 0 | [记录](https://icpc.njxzu.cn/record/6abccb1f6ded9b2cf4445214) |
| 无输入 | 私有文件路径探针并正确交互 | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abccb1f6ded9b2cf444521a) |
| 无输入 | 读取 challenge 后提前退出 | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abccb1f6ded9b2cf4445220) |
| 有输入 | 正确解并 flush | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf444523c) |
| 有输入 | 答案加一 | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf4445243) |
| 有输入 | 仅通过 30 分子任务 | WA | 30 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf4445249) |
| 有输入 | CPU 忙等 | TLE | 0 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf444524f) |
| 有输入 | 私有文件路径探针并正确交互 | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf4445254) |
| 异常探针 | 正确解（基线） | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf444525b) |
| 异常探针 | 触发交互器 `abort()` | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf4445261) |
| 异常探针 | 触发 testlib `_fail` | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abccb756ded9b2cf4445266) |

## `auto` 修复与直接导入补测

按用户要求，新导出统一为 `interactor: { file: interactor.cc, lang: auto }`。即使旧程序调用方传入 `cc.cc17` 或 `cc.cc20`，新生成包也会规范为 `auto`；现存旧目录仍可校验和打包，不改写旧发布包。本地验证和 DOMjudge 的 C++ 标准选择不变。

Hydro 官方 [编译入口](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrojudge/src/task.ts) 在 `lang: auto` 时按扩展名查找语言；本项目的 `interactor.cc` 会使用目标站的 `cc` 配置，此站为 C++14。`auto` 不等于强制使用编辑器选定的 C++ 标准，源码需要兼容实际编译配置。

下面两个包由修复后的导出函数生成，直接 ZIP 导入，没有额外替换配置或修改站点。读取站点题目配置也确认保存为 `lang: auto`。选手提交沿用此站 `cc.cc20o2`，与交互器的自动选择独立。

| 新导出包 | SHA-256 |
| --- | --- |
| auto 全空交互 | `833b011d40125f885f3dd13033184d623f1e728b1e5ae5d09eb790ae78e48dea` |
| auto 有输入交互 | `7edc3c606ffc592534e3a0fd0e901e2ba3dbe387d048e6b462ae3f67691b88d2` |

| 题目 | 程序 | 判定 | 分数 | 提交 |
| --- | --- | --- | --- | --- |
| auto 全空 | 正确解并 flush | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452a6) |
| auto 全空 | 答案加一 | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452ad) |
| auto 全空 | CPU 忙等 | TLE | 0 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452b3) |
| auto 有输入 | 正确解并 flush | AC | 100 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452b9) |
| auto 有输入 | 答案加一 | WA | 0 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452c0) |
| auto 有输入 | CPU 忙等 | TLE | 0 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452c6) |
| auto 有输入 | 仅通过 30 分子任务 | WA | 30 | [记录](https://icpc.njxzu.cn/record/6abccffb6ded9b2cf44452ce) |

本地 `hydro-authoring/test/authoring.test.ts` 的 16 项定向测试及 `npm run check` 通过，包括 `auto` 导出/校验、旧参数规范化、旧目录兼容和非法语言拒绝。此补测只解决语言兼容，不把首轮异常判定问题计为已解决。

私有文件探针检查 `/w/in`、`/w/out`、`/w/tout`、`/w/interactor.cc`、`interactor.cc`、`interactive-empty.in`、`1.in`、`2.in`、`/jury/input.in`、`/jury/answer.ans` 和 `/program/interactor.cc`。上述路径在选手运行环境均不可读取。该结果只覆盖列出的路径，不是完整判题机安全审计。

## 未通过的验收项与原因

语言 ID 不匹配已在 `auto` 补测中解决；首轮使用旧配置的包与记录保留作为历史证据。仍未通过：

1. **不 flush 的死锁没有判为 TLE。** 选手被终止后，此站返回 `Your program returned 9`，实际判为 RE；CPU 忙等则正确判为 TLE。
2. **裁判异常被判为 WA。** `abort()` 的日志为 `Interactor exited with code 6`；`_fail` 的日志为 `FAIL Deliberate jury failure acceptance probe`，两者实际均为 WA。此行为不满足“裁判异常不得误判选手 WA”的验收要求。

Hydro 官方当前 [交互判题实现](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrojudge/src/judge/interactive.ts) 使用选手 CPU 时间和退出状态判定，并解析交互器 stderr；[testlib 输出解析](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrojudge/src/testlib.ts) 默认状态为 WA，未专门处理 `FAIL`。该实现可解释上述结果，但未取得此站判题器安装源码，因此不将当前上游源码等同于此站精确版本。

Setdraft 本地交互沙箱关于异常区分和取消清理的测试与此平台行为独立。需要修正或升级目标判题器并重新测试，才能确认此站满足全部异常验收门槛；仅更改 testlib 退出码不能保证解决。此次只修改 Setdraft 的 Hydro 交互器语言导出和相应校验/测试/文档，未修改线上评测器或全局设置。

测试脚本、原始/适配/auto ZIP、提交源码和机器可读结果（首轮 `results.json`、补测 `auto-results.json`）保存在本地 `.artifacts/hydro-platform-acceptance-20260930/`；凭据不写入本文或提交源码。补测后已退出账号并删除本地登录会话。
