export const problemTypeMessages: Record<string, string> = {
	题型: "Problem type",
	标准题: "Standard",
	特判题: "Special judge",
	交互题: "Interactive",
	通信题: "Communication",
	题型与计分方式: "Problem type and scoring",
	"运行程序后，与标准答案进行文本比较。": "Run the program, then compare its output with the answer as text.",
	"运行程序后，由自定义 Checker 判定输出。": "Run the program, then judge its output with a custom checker.",
	"选手程序与 Interactor 完成一次双向交互。": "Run one complete dialogue between the program and the interactor.",
	"同一程序启动两轮，由通信裁判传递信息；每轮独立限额。":
		"Start the same program twice. The communication judge passes information between rounds; each round has its own limits.",
	程序与判题: "Programs and judging",
	程序与判题分区: "Program and judge sections",
	通信设置: "Communication settings",
	内置文本比较: "Built-in text comparison",
	"文本比较统一换行，忽略行尾空格、制表符和末尾空行；内部空格、大小写与数字写法必须一致。":
		"Text comparison normalizes line endings and ignores trailing spaces, tabs and blank lines. Internal spacing, letter case and number formatting must match.",
	"切换题型会保留已有题面、程序和数据，发布前需重新验证。":
		"Changing the problem type keeps statements, programs and data. Verify again before publishing.",
	测试输入来源: "Test input source",
	无测试输入: "No test input",
	使用私有测试数据: "Use private test data",
	"使用一个严格空测试点，裁判自行组织固定场景。":
		"Use a single zero-byte test case. The judge defines a fixed scenario.",
	"Gen 或手动数据作为裁判私有输入，选手通过协议获取信息。":
		"Generator or manual data becomes private judge input. Contestants receive information through the protocol.",
	"自动使用一个严格空的测试点。已有数据与分组保留，切回有输入模式即可恢复。":
		"Use one zero-byte test case. Existing data and groups are preserved and restored when private input is enabled.",
	"上传 .in 作为第一轮裁判私有输入；第二轮输入通过裁判显式交接，最终比较答案由主标程运行两轮生成。":
		"Upload .in files as private input for round one. The judge explicitly passes input to round two. For final output comparison, the primary solution generates the answer by completing both rounds.",
	"Gen 生成第一轮裁判私有输入；多 Gen 共用脚本，主标程运行两轮验证。第二轮文本或特判的答案由主标程生成。":
		"Generators share one script and produce private input for round one. The primary solution verifies both rounds and generates answers for text or special judging in round two.",
	"主标程和通信裁判必填；每个标程独立完成两轮。发送消息后必须 flush。":
		"A primary solution and communication judge are required. Each solution completes both rounds independently. Flush after sending messages.",
	"主标程生成答案；标准题使用内置文本比较。必检解法影响发布，仅观察解法提供提示。":
		"The primary solution generates answers using built-in text comparison. Required solutions affect publication; observations provide guidance.",
	"主标程生成答案；特判题使用自定义 Checker。必检解法影响发布，仅观察解法提供提示。":
		"The primary solution generates answers using a custom checker. Required solutions affect publication; observations provide guidance.",
	"主标程必须完整完成两轮且全点满分，全部必检程序须符合预期；公开协议样例不参与评测。":
		"The primary solution must finish both rounds with full scores. All required programs must meet their expectations. Public protocol examples are excluded from judging.",
	"通信裁判 · C++ testlib": "Communication judge · C++ testlib",
	第一轮: "First round",
	信息交接: "Handoff",
	第二轮: "Second round",
	第二轮判定: "Second-round judging",
	"继续交互（默认）": "Continue interaction (default)",
	"特判 Checker": "Custom checker",
	"通信裁判与 Checker 共用 {0} 编译，取各自设置的较高标准。":
		"The communication judge and checker compile together as {0}, using the higher of their selected standards.",
	"两轮使用全新进程和临时目录。第一轮不计分，第二轮决定分数；第一轮失败将跳过第二轮。耗时与内存显示两轮最大值。":
		"Each round uses a fresh process and temporary directory. Only round two scores; a failed first round skips the second. Time and memory show the maximum across rounds.",
	"覆盖现有通信裁判代码？": "Replace the communication judge source?",
	导入通信裁判模板: "Use communication judge template",
	配套标程语言: "Reference template language",
	导入配套标程: "Use reference solution template",
	"通过 communicationRound() 取得轮次；inf 读取原始私有输入；communicationHandoff() 读取交接；saveCommunicationHandoff(信息, 第二轮输入) 保存交接。模板向选手发送 first／second。":
		"communicationRound() returns the round. inf reads original private input. communicationHandoff() reads the handoff; saveCommunicationHandoff(data, secondInput) saves it. The template sends first/second to the contestant.",
	通信说明: "Communication",
	第一轮协议: "First-round protocol",
	第二轮协议: "Second-round protocol",
	交互协议: "Interaction protocol",
	交互消息: "Interaction messages",
	"协议样例是有序的公开消息，不作为私有测试点。Alt＋↑／↓ 可调整消息顺序。":
		"Protocol examples are ordered public messages, excluded from private tests. Press Alt + Up/Down to reorder messages.",
	"协议样例 {0}": "Protocol example {0}",
	"消息 {0} 发送方": "Message {0} sender",
	裁判发送: "Judge sends",
	选手发送: "Contestant sends",
	"上移消息 {0}": "Move message {0} up",
	"下移消息 {0}": "Move message {0} down",
	"第 {0} 轮消息 {1}": "Round {0}, message {1}",
	添加消息: "Add message",
	添加协议样例: "Add protocol example",
	手动整理消息顺序: "Arrange messages manually",
	"旧双栏内容保持原样；请手动整理为有序消息，确认后可删除旧样例。":
		"Legacy two-column content is preserved. Arrange it as ordered messages manually, then remove the legacy example when ready.",
	"旧双栏样例 {0}（顺序未整理）": "Legacy two-column example {0} (order unspecified)",
	"旧双栏样例（消息顺序未整理）": "Legacy two-column examples (order unspecified)",
	"第 {0} 轮": "Round {0}",
	" · 第{0}轮": " · Round {0}",
	" · 两轮通信已测试": " · Both communication rounds verified",
	"本地耗时与内存为两轮最大值；外部平台可能只展示最后一轮资源。":
		"Local time and memory show the maximum across rounds. External platforms may show only the final round.",
	轮次诊断: "Round diagnostics",
	未运行: "Not run",
	"未运行：第一轮失败": "Not run: round one failed",
	通信记录与裁判日志: "Communication and judge logs",
	下载交接数据: "Download handoff",
	下载轮次文件: "Download round file",
	"轮次日志读取失败。": "Could not load the round log.",
	"通信题暂不支持 FPS／QDUOJ，请使用 Hydro 或 DOMjudge。":
		"Communication problems do not support FPS/QDUOJ. Export to Hydro or DOMjudge.",
};
