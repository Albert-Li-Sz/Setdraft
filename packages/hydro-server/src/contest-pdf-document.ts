import { statementSectionList } from "@setdraft/authoring/statement";
import { type ContestPdfOptions, type ManualProject, resolveProblemType, usesProtocol } from "@setdraft/contracts";
import { preparePdfFootnotes, preparePdfMarkdown, preparePdfMarkdownParts, typstString } from "./markdown-typst.ts";

export interface PdfProblem
	extends Pick<
		ManualProject,
		| "statement"
		| "statementSections"
		| "judgingMode"
		| "problemType"
		| "protocolSamples"
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
		const interactive = usesProtocol(problem);
		const sections = problem.statementSections;
		const selected = statementSectionList(problem);
		const prepared = preparePdfFootnotes(
			preparePdfMarkdownParts(
				selected.map(({ key }) => sections?.[key] ?? (key === "description" ? problem.statement : "")),
				images,
			),
		);
		const fields = new Map(selected.map(({ key }, index) => [key, typstString(prepared.parts[index])]));
		const field = (key: string) => fields.get(key as (typeof selected)[number]["key"]) ?? typstString("");
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
  label: ${typstString(problem.label)}, display_name: ${typstString(problem.title)}, format: "markdown", interactive: ${interactive}, problem_type: ${typstString(resolveProblemType(problem))},
  limits: (${limits.map(([key, value]) => `(key: ${typstString(key)}, value: ${typstString(value)})`).join(", ")},),
  samples: (${problem.samples.map((sample) => `(input: ${typstString(sample.input)}, output: ${typstString(sample.output)}),`).join("\n")}),
  protocol_samples: (${(interactive ? (problem.protocolSamples ?? []) : [])
		.map(
			(sample) =>
				`(rounds: (${sample.rounds
					.filter((group) => resolveProblemType(problem) === "communication" || group.round === 1)
					.map(
						(group) =>
							`(round: ${group.round}, messages: (${group.messages.map((message) => `(sender: ${typstString(message.sender)}, text: ${typstString(message.text)}),`).join(" ")})),`,
					)
					.join(" ")})),`,
		)
		.join(" ")}),
), statement: (
  footnotes: (${prepared.footnotes.map((note) => `(body: ${typstString(note.body)}, nested: (${note.nested.map((index) => `${index},`).join(" ")})),`).join(" ")}),
  description: ${field("description")},
  input: ${field("input")},
  output: ${field("output")},
  interaction: ${field("interaction")},
  notes: ${field("notes")},
  communication: ${field("communication")},
  first_round: ${field("firstRound")},
  second_round: ${field("secondRound")},
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
