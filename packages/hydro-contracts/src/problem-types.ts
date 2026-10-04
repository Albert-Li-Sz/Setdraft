import type { CheckerMode, CppLanguage, InteractionInputMode, JudgingMode, ManualCheck } from "./index.ts";
import { cppLanguages } from "./languages.ts";

export const problemTypes = ["standard", "special", "interactive", "communication"] as const;
export type ProblemType = (typeof problemTypes)[number];
export const problemTypeNames: Record<ProblemType, string> = {
	standard: "标准题",
	special: "特判题",
	interactive: "交互题",
	communication: "通信题",
};
export interface CommunicationConfig {
	judgeSource: string;
	judgeStandard: CppLanguage;
	secondRound: "interactive" | "text" | "custom";
}
/** The portable judge embeds the final checker, so both share one compiler. */
export function communicationCompileStandard(config: CommunicationConfig, checkerStandard: CppLanguage): CppLanguage {
	return config.secondRound === "custom" &&
		cppLanguages.indexOf(checkerStandard) > cppLanguages.indexOf(config.judgeStandard)
		? checkerStandard
		: config.judgeStandard;
}
export interface ProtocolMessage {
	id?: string;
	sender: "judge" | "contestant";
	text: string;
}
export interface ProtocolSample {
	id?: string;
	/** Communication samples have separate first and second round groups. */
	rounds: Array<{ round: 1 | 2; messages: ProtocolMessage[] }>;
}
export interface RoundResult {
	round: 1 | 2;
	state: "complete" | "skipped";
	verdict?: ManualCheck["verdict"];
	score?: number;
	durationMs?: number;
	memoryBytes?: number;
	message: string;
	logPath?: string;
	artifacts?: string[];
}

/** A failed first round is a complete judged case; infrastructure faults are not. */
export function isCompleteCommunicationResult(result: {
	verdict?: ManualCheck["verdict"];
	score?: number;
	failedRound?: 1 | 2;
	rounds?: RoundResult[];
}): boolean {
	const rounds = result.rounds;
	if (!rounds || rounds.length !== 2 || rounds[0].round !== 1 || rounds[1].round !== 2) return false;
	const [first, second] = rounds;
	const judged = (round: RoundResult) =>
		round.state === "complete" &&
		round.verdict !== undefined &&
		round.verdict !== "CE" &&
		round.verdict !== "SYSTEM_ERROR";
	if (!judged(first) || first.score !== 0) return false;
	if (first.verdict !== "AC")
		return (
			second.state === "skipped" &&
			result.verdict === first.verdict &&
			result.score === 0 &&
			result.failedRound === 1
		);
	return (
		judged(second) &&
		result.verdict === second.verdict &&
		result.score === second.score &&
		(second.verdict === "AC" && second.score === 100 ? result.failedRound === undefined : result.failedRound === 2)
	);
}
export interface ProblemTypeView {
	problemType?: ProblemType;
	judgingMode?: JudgingMode;
	checkerMode?: CheckerMode;
	checkerSource?: string;
	interactionInputMode?: InteractionInputMode;
	communication?: CommunicationConfig;
	protocolSamples?: ProtocolSample[];
}
export function isProblemType(value: unknown): value is ProblemType {
	return problemTypes.some((type) => type === value);
}
/** The only legacy-to-canonical conversion; explicit canonical types always win. */
export function resolveProblemType(project: ProblemTypeView): ProblemType {
	return (
		project.problemType ??
		(project.judgingMode === "interactive"
			? "interactive"
			: (project.checkerMode ?? (project.checkerSource?.trim() ? "custom" : "text")) === "custom"
				? "special"
				: "standard")
	);
}
export function usesProtocol(project: ProblemTypeView): boolean {
	const type = resolveProblemType(project);
	return type === "interactive" || type === "communication";
}
export function hasEmptyInput(project: ProblemTypeView): boolean {
	return usesProtocol(project) && project.interactionInputMode === "empty";
}
export function needsAnswer(project: ProblemTypeView): boolean {
	const type = resolveProblemType(project);
	return (
		type === "standard" ||
		type === "special" ||
		(type === "communication" && project.communication?.secondRound !== "interactive")
	);
}
/** Legacy fields are derived views. Hidden source code is deliberately retained. */
export function synchronizeProblemType(project: ProblemTypeView): void {
	const sampleIds = new Set(project.protocolSamples?.flatMap((sample) => (sample.id ? [sample.id] : [])));
	const availableId = (base: string, ids: Set<string>) => {
		let id = base;
		for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
		ids.add(id);
		return id;
	};
	project.protocolSamples = project.protocolSamples?.map((sample, index) => ({
		...sample,
		id: sample.id ?? availableId(`sample-${index}`, sampleIds),
		rounds: ([1, 2] as const).map((round) => {
			const group = sample.rounds.find((item) => item.round === round) ?? { round, messages: [] };
			const messageIds = new Set(group.messages.flatMap((message) => (message.id ? [message.id] : [])));
			return {
				...group,
				messages: group.messages.map((message, position) => ({
					...message,
					id: message.id ?? availableId(`message-${round}-${position}`, messageIds),
				})),
			};
		}),
	}));
	project.problemType = resolveProblemType(project);
	project.judgingMode = usesProtocol(project) ? "interactive" : "default";
	project.interactionInputMode ??= "provided";
	project.communication ??= { judgeSource: "", judgeStandard: "cpp17", secondRound: "interactive" };
	project.checkerMode =
		project.problemType === "special" ||
		(project.problemType === "communication" && project.communication.secondRound === "custom")
			? "custom"
			: "text";
}
export function isProtocolSamples(value: unknown): value is ProtocolSample[] {
	if (!Array.isArray(value) || value.length > 20) return false;
	const sampleIds = new Set<string>();
	const validId = (item: object, ids: Set<string>) => {
		if (!("id" in item) || item.id === undefined) return true;
		if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(item.id) || ids.has(item.id))
			return false;
		ids.add(item.id);
		return true;
	};
	return value.every((sample: unknown) => {
		if (
			!sample ||
			typeof sample !== "object" ||
			!("rounds" in sample) ||
			!Array.isArray(sample.rounds) ||
			sample.rounds.length > 2 ||
			!validId(sample, sampleIds)
		)
			return false;
		const seen = new Set<number>();
		return sample.rounds.every((group: unknown) => {
			if (
				!group ||
				typeof group !== "object" ||
				!("round" in group) ||
				(group.round !== 1 && group.round !== 2) ||
				seen.has(group.round) ||
				!("messages" in group) ||
				!Array.isArray(group.messages) ||
				group.messages.length > 200
			)
				return false;
			seen.add(group.round);
			const messageIds = new Set<string>();
			return group.messages.every(
				(message: unknown) =>
					message !== null &&
					typeof message === "object" &&
					"sender" in message &&
					(message.sender === "judge" || message.sender === "contestant") &&
					"text" in message &&
					typeof message.text === "string" &&
					message.text.length <= 200_000 &&
					validId(message, messageIds),
			);
		});
	});
}
