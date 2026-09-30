import type { ContestPdfOptions, ManualProject } from "@setdraft/contracts";
import { preparePdfMarkdown, preparePdfMarkdownParts, typstString } from "./markdown-typst.ts";

export interface PdfProblem
	extends Pick<
		ManualProject,
		| "statement"
		| "statementSections"
		| "judgingMode"
		| "samples"
		| "attachments"
		| "timeLimit"
		| "memoryLimit"
		| "title"
	> {
	label: string;
}

export interface ContestPdfDocument {
	title: string;
	options: ContestPdfOptions;
	problems: PdfProblem[];
}

export function buildContestPdfSources(document: ContestPdfDocument) {
	const { title, options, problems } = document;
	const language = options.problemLanguage === "auto" ? options.language : options.problemLanguage;
	const assets = new Map<string, Buffer>();
	const entries = problems.map((problem) => {
		const images = new Map<string, string>();
		for (const [index, attachment] of problem.attachments.entries()) {
			const extension = attachment.name.split(".").at(-1)?.toLowerCase();
			if (!extension || !["png", "jpg", "jpeg", "gif", "svg"].includes(extension)) continue;
			const name = `images/${problem.label}-${index}.${extension}`;
			assets.set(name, Buffer.from(attachment.contentBase64, "base64"));
			images.set(`file://${attachment.name}`, `/${name}`);
		}
		const interactive = problem.judgingMode === "interactive";
		const sections = problem.statementSections;
		const [description, input, output, interaction, notes] = preparePdfMarkdownParts(
			[
				sections?.description ?? problem.statement,
				interactive ? "" : (sections?.input ?? ""),
				interactive ? "" : (sections?.output ?? ""),
				interactive ? (sections?.interaction ?? "") : "",
				sections?.notes ?? "",
			],
			images,
		).map(typstString);
		const limits =
			language === "en"
				? [
						["Time Limit", problem.timeLimit],
						["Memory Limit", problem.memoryLimit],
					]
				: [
						["时间限制", problem.timeLimit],
						["内存限制", problem.memoryLimit],
					];
		return `(problem: (
  label: ${typstString(problem.label)}, display_name: ${typstString(problem.title)}, format: "markdown", interactive: ${interactive},
  limits: (${limits.map(([key, value]) => `(key: ${typstString(key)}, value: ${typstString(value)})`).join(", ")},),
  samples: (${problem.samples.map((sample) => `(input: ${typstString(sample.input)}, output: ${typstString(sample.output)}),`).join("\n")}),
), statement: (
  description: ${description},
  input: ${input},
  output: ${output},
  interaction: ${interaction},
  notes: ${notes},
))`;
	});
	const source = (selected: string[], standalone: boolean) => `#import "/xcpc/lib.typ": contest-conf
#show: contest-conf.with(
  title: ${typstString(title)}, subtitle: ${typstString(options.subtitle)},
  author: ${typstString(options.author)}, date: ${typstString(options.date)},
  language: ${typstString(options.language)},
  titlepage-language: ${options.titlePageLanguage === "auto" ? "auto" : typstString(options.titlePageLanguage)},
  problem-language: ${options.problemLanguage === "auto" ? "auto" : typstString(options.problemLanguage)},
  enable-titlepage: ${!standalone && options.titlePage},
  enable-problem-list: ${!standalone && options.problemList},
  enable-header-footer: ${!standalone && options.headerFooter},
  cover-notes: ${typstString(!standalone && options.titlePage ? preparePdfMarkdown(options.coverNotes) : "")},
  problems: (${selected.map((entry) => `${entry},`).join("\n")}),
)
`;
	return {
		assets,
		booklet: source(entries, false),
		problems: new Map(problems.map((problem, index) => [problem.label, source([entries[index]], true)])),
	};
}
