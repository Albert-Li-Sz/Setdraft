import { defaultContestPdfOptions } from "@setdraft/contracts";
import type { ContestPdfDocument } from "../../src/contest-pdf-document.ts";

export const pdfFixture: ContestPdfDocument = {
	title: "Setdraft 程序设计竞赛",
	options: {
		...defaultContestPdfOptions,
		enabled: true,
		author: "命题组",
		date: "2026-09-29",
		coverNotes: "请检查试题册是否完整。比赛时长：**5 小时**。",
	},
	problems: [
		{
			label: "A",
			title: "A + B 求和",
			timeLimit: "1s",
			memoryLimit: "256m",
			statement: "",
			statementSections: {
				description: "给定两个整数，计算它们的和。\n\n$1 \\le a,b \\le 10^9$，答案为 $a+b$。",
				input: "一行两个整数 $a,b$。",
				output: "输出 $a+b$。",
				interaction: "隐藏的交互协议",
				notes: "注意整数范围。",
			},
			samples: [{ input: "1 2\n", output: "3\n" }],
			attachments: [],
		},
		{
			label: "B",
			title: "交互翻倍",
			timeLimit: "2s",
			memoryLimit: "256m",
			statement: "",
			judgingMode: "interactive",
			statementSections: {
				description: "这是交互题。",
				input: "隐藏普通输入",
				output: "隐藏普通输出",
				interaction: "交互器发送一个整数。返回它的两倍，然后 **flush**。\n\n发生 EOF 后退出。",
				notes: "不要读取私有测试文件。",
			},
			samples: [{ input: "21", output: "42" }],
			attachments: [],
		},
	],
};
