# 交互与通信题：使用与验收

完整工作台流程见 [出题文档](authoring-guide.md)，也可从工作台“复制给用户”旁的文档按钮打开站内页面。
左侧题型选择“交互题”或“通信题”，测试数据页选择“使用私有测试数据”或“无测试输入”。
交互题完成一次双向交互；通信题将同一份选手程序独立启动两轮，由一个通信裁判显式交接信息。

## 输入约定

有输入模式的 `.in` 是裁判私有数据，不是直接发送给选手的标准输入。选手只能接收交互器明确发送的内容。
无输入模式始终使用一个严格空文件；不会自动填入 seed 或时间戳。需要可复现随机场景时，应选择有输入模式，
自己在 `.in` 中保存 seed，并让交互器使用确定性生成逻辑。

不需要 `.ans` 或 `.out` 的内容。已有答案保留在制题工程中，但不参与交互判断；导出的答案始终为空。
切换题型或输入模式不会删除隐藏的 checker、生成器、validator、数据和子任务配置。
无输入模式只运行自动测试点，切回后恢复原数据。公开样例是协议说明，不是私有测试点。
标准／特判题输入输出、交互协议及通信栏目在切换时保留。新协议样例使用有序消息，每条标明发送方，
通信样例按轮次分组；支持上移、下移和 Alt＋↑／↓。旧双栏内容保留，通过手动整理入口安排顺序。

## 模板

在程序页先“导入交互器模板”，再按需“导入配套标程”；覆盖已有代码前会询问确认。

模板通信顺序：交互器发送整数 `challenge` 并 flush；选手返回 `2 * challenge` 并 flush；交互器自行判定。
有输入模板的 `.in` 可写 `21`，无输入模板固定使用 21。模板源码维护在
`packages/hydro-contracts/src/interactive-templates.ts`，定向测试会真实编译并运行两种模板。

本地 testlib 调用为 `interactor input.in transcript answer.ans`。
正确解使用 `_ok`，错误解使用 `_wa`；输入、裁判异常使用 `_fail`。不要直接用任意退出码代替 testlib 判定。
只有全部参考解得到满分才可发布。可选第二标准程序会重新启动并独立执行每个测试点。

双方须及时 flush，处理协议结束与 EOF。无限等待或不 flush 会超时，提前退出可能导致 WA/RE；
交互器崩溃或非法判定属于系统错误，不会伪装成 WA。日志只保存每个方向前 64 KiB，并标注是否截断。
日志和私有输入都仅面向有权访问该题目的作者。

## 导出

Hydro 使用 `type: interactive`，统一写入 `interactor: { file: interactor.cc, lang: auto }`；
交互源码位于 `testdata`。Hydro 根据 `.cc` 扩展名使用目标站的 `cc` 编译配置，不依赖固定的版本语言 ID。
编辑器选择的 C++ 标准仍用于本地验证和 DOMjudge，Hydro 实际编译标准由目标站配置决定，源码须与之兼容。
单次交互不启用 `multi_pass`。通信题固定 `multi_pass: 2`，第二轮文本／特判由适配器完成；
只使用裁判私有 `nextpass.in` 交接，不写入会分享给选手的 `state.txt`。旧发布包保持原样。

DOMjudge 基线是官方 9.0.1，只支持 ACM：

```text
problem.yaml                         validation: custom interactive
domjudge-problem.ini                  时间限制和稳定题目 ID
data/secret/001.in                    私有输入或严格空文件
data/secret/001.ans                   严格空答案
output_validators/interactor/
  interactor.cc
  testlib.h
  build                              编译选定 C++ 标准
  run                                双向转发与退出状态适配
```

`build` 和 `run` 在 ZIP 中保留可执行权限；导入器自行注册交互 executable，不引用预先配置的 ID。
DOMjudge 调用 `run input answer feedback-directory`，适配器保留 stdin/stdout 双向通信，
将 testlib 的 AC/WA 映射为 42/43，异常映射为非 42/43 的系统错误。
导出前使用真实标程运行相同适配器，而不是把空答案当作选手输出。交互题不生成 `data/sample`。

通信题在 DOMjudge 9.0.1 组合使用 `type: pass-fail interactive multi-pass`、
`validation: custom interactive` 与 `limits.validation_passes: 2`。适配器封装第一轮私有输入，
通过 `nextpass.in` 进入第二轮，保存原始输入及显式交接；不依赖选手共享临时文件。

## 通信裁判与两轮资源

程序页可导入通信裁判模板与 C++／Python／Java 标程。辅助头文件由适配器提供：
`communicationRound()` 取得轮次，`inf` 读取原始私有输入，`communicationHandoff()` 读取显式交接，
第一轮调用 `saveCommunicationHandoff(信息, 第二轮输入)` 保存交接。

第一轮结束后以新进程和新临时目录启动同一份源码；变量和文件不继承。第二轮默认继续交互，
也可投递第二轮输入并采用文本比较或自定义 Checker。文本／特判标准答案由主标程完整运行两轮生成。
Checker 读取原始私有输入、最终输出和标准答案。每份源码每个任务只编译一次。
第二轮特判的 Checker 嵌入通信裁判，本地和 DOMjudge 使用两者所选 C++ 标准中较高的标准统一编译；
各自的编辑器设置仍保留。Hydro 使用目标站的 `cc` 配置，须确认它支持这一标准。

第一轮不计分，第二轮决定分数；第一轮 WA/TLE/MLE/RE 记零分并跳过第二轮。缺失／非法交接、
裁判故障或请求第三轮属于系统错误。每轮独立使用题目限制，本地汇总取两轮最大耗时和内存，
诊断详情保留逐轮数据与日志；外部平台的展示口径另行核对。首版不包含任意轮数、不同源码或多进程题。

竞赛 PDF 在竞赛内统一配置并由所选发布题面生成，交互与通信题使用协议、有序样例及轮次排版。
开启 PDF 后，竞赛包包含 `booklet.pdf` 和 `statements/A.pdf` 等单题文件，DOMjudge 逐题 ZIP 自动附带对应 PDF。
首页副标题、署名、日期、Markdown 说明、语言、题目列表和页眉页脚可编辑；保存后先预览再导出。
旧的逐题 DOMjudge PDF 上传入口由此替代，旧发布包不改写。

参考官方实现：[DOMjudge 9.0.1 ZIP 导入](https://github.com/DOMjudge/domjudge/blob/9.0.1/webapp/src/Service/ImportProblemService.php)、
[DOMjudge 9.0.1 交互执行](https://github.com/DOMjudge/domjudge/blob/9.0.1/judge/run-interactive.sh)、
[Hydro 交互执行](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrojudge/src/judge/interactive.ts)。

## 本地回归

需要 Docker、`setdraft/sandbox:local` 镜像和 Node/npm 依赖；数据库测试工具会创建并移除自己的临时 PostgreSQL。

```bash
cd packages/hydro-server
node ../../scripts/test-server.mjs test/problem-types.test.ts test/communication-project.test.ts test/communication-sandbox.test.ts test/interactive-project.test.ts test/interactive-sandbox.test.ts
```

覆盖配置保存、切换后数据保留、空输入、ACM/OI、历史恢复、赛事入口、真实 C++/Python/Java 交互、
正确解、错误解、不 flush、EOF、输出超限、交互器崩溃、部分分数、生成器和 validator、编译及运行隔离、
整组取消清理，以及 DOMjudge 适配器正确／错误／系统异常状态。仓库根目录另运行 `npm run check`。

## 真实平台验收门槛

本地回归不是完整的平台验收。Hydro 与 DOMjudge 需要分别在目标实例执行实际导入与提交测试，
检查编译配置、空输入、有输入、OI 计分、超时、裁判异常和文件隔离行为。
不要把 ZIP 结构通过或本地适配器通过记作平台验收通过。

在独立测试实例上，为两种交互输入模式、通信的继续交互／最终比较流程执行以下步骤，并记录平台版本、发布包哈希、题目 ID、提交 ID 与判定：

1. 从 Setdraft 完整验证并发布；Hydro 导入 Hydro ZIP，DOMjudge 仅导入 DOMjudge ZIP。
2. 确认平台识别为交互题、时间内存和测试点数量正确；DOMjudge 无需手动填 executable ID。
3. 提交配套正确解，全部测试点应 AC；提交将答案加一的程序，应 WA。
4. 提交不 flush 后等待的程序，应 TLE；验证平台不会把裁判崩溃当作普通 WA。
5. 通过选手文件访问探针确认不能直接读取私有输入或交互器源文件。
6. Hydro 额外验证 OI 子任务分数；DOMjudge 只验收 ACM。检查空输入文件确实为零字节。

这些步骤全部完成并保存结果之前，真实平台兼容验收仍为未完成状态。
