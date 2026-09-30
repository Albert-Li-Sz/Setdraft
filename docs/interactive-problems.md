# 交互题：使用与验收

完整工作台流程见 [出题文档](authoring-guide.md)，也可从工作台“复制给用户”旁的文档按钮打开站内页面。
题目配置开启“交互题”后，题面分栏变为“描述、交互描述、提示、样例”；在测试数据页选择“全交互”或“半对拍”。
全交互对应无输入，半对拍对应有输入，两者都使用交互器双向通信；半对拍不改用普通 Checker 或 `special_compare`。

## 输入约定

有输入模式的 `.in` 是裁判私有数据，不是直接发送给选手的标准输入。选手只能接收交互器明确发送的内容。
无输入模式始终使用一个严格空文件；不会自动填入 seed 或时间戳。需要可复现随机场景时，应选择有输入模式，
自己在 `.in` 中保存 seed，并让交互器使用确定性生成逻辑。

不需要 `.ans` 或 `.out` 的内容。已有答案保留在制题工程中，但不参与交互判断；导出的答案始终为空。
切换题型或输入模式不会删除隐藏的 checker、生成器、validator、数据和子任务配置。
无输入模式只运行自动测试点，切回后恢复原数据。公开样例是协议说明，不是私有测试点。
普通题输入/输出栏目与交互描述切换时保留，只展示当前题型所需栏目。样例在“题面 → 样例”编辑，
两侧分别表示交互器发送和选手发送的内容，多轮顺序需在交互描述或提示中明确。

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
不增加普通 checker 或 `multi_pass`。旧发布包不自动改写，需要重新发布才能获得 `auto` 配置。

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

竞赛 PDF 在竞赛内统一配置并由所选发布题面生成，交互题使用交互描述与协议样例。
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
node ../../scripts/test-server.mjs test/interactive-project.test.ts test/interactive-sandbox.test.ts test/project-history.test.ts test/sandbox-cancellation.test.ts
```

覆盖配置保存、切换后数据保留、空输入、ACM/OI、历史恢复、赛事入口、真实 C++/Python/Java 交互、
正确解、错误解、不 flush、EOF、输出超限、交互器崩溃、部分分数、生成器和 validator、编译及运行隔离、
整组取消清理，以及 DOMjudge 适配器正确／错误／系统异常状态。仓库根目录另运行 `npm run check`。

## 真实平台验收门槛

本地回归不是完整的平台验收。2026-09-30 已在 Hydro v5.0.7 实例完成实际导入与核心提交测试，
统一 `auto` 的新包已直接导入并通过有输入/空输入 AC、WA、CPU TLE 和 OI 计分补测，无需手动适配语言 ID。
不 flush 和裁判异常的判定尚未满足全部门槛；详见
[Hydro 实例验收记录](hydro-acceptance-2026-09-30.md)。DOMjudge 9.0.1 的实际导入和提交验收仍待完成。
不要把 ZIP 结构通过或本地适配器通过记作平台验收通过。

在独立测试实例上，分别为有输入和空输入题执行以下步骤，并记录平台版本、发布包哈希、题目 ID、提交 ID 与判定：

1. 从 Setdraft 完整验证并发布；Hydro 导入 Hydro ZIP，DOMjudge 仅导入 DOMjudge ZIP。
2. 确认平台识别为交互题、时间内存和测试点数量正确；DOMjudge 无需手动填 executable ID。
3. 提交配套正确解，全部测试点应 AC；提交将答案加一的程序，应 WA。
4. 提交不 flush 后等待的程序，应 TLE；验证平台不会把裁判崩溃当作普通 WA。
5. 通过选手文件访问探针确认不能直接读取私有输入或交互器源文件。
6. Hydro 额外验证 OI 子任务分数；DOMjudge 只验收 ACM。检查空输入文件确实为零字节。

这些步骤全部完成并保存结果之前，真实平台兼容验收仍为未完成状态。
