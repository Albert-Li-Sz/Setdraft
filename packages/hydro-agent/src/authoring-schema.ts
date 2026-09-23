import { Type } from "typebox";

export const programSchema = Type.Object({
	language: Type.Union([Type.Literal("cpp17"), Type.Literal("python3"), Type.Literal("java")]),
	code: Type.String({ minLength: 1, maxLength: 200000 }),
});
const cppSource = Type.String({
	minLength: 1,
	maxLength: 200000,
	description: "Complete C++17 source using testlib.h",
});

export const authoringProjectSchema = Type.Object({
	type: Type.Optional(
		Type.Union([Type.Literal("default"), Type.Literal("interactive"), Type.Literal("submit_answer")]),
	),
	multiPass: Type.Optional(Type.Integer({ minimum: 2, maximum: 20 })),
	answerMode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multi")])),
	reference: programSchema,
	oracle: programSchema,
	generator: cppSource,
	validator: cppSource,
	checker: Type.Optional(cppSource),
	interactor: Type.Optional(cppSource),
	queryLimitProbe: Type.Optional(programSchema),
	cases: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique flat ASCII case ID, used later by build_hydro_problem" }),
			submissionFile: Type.Optional(
				Type.String({ description: "For multi-file submit_answer: required filename inside contestant ZIP" }),
			),
			purpose: Type.Union([
				Type.Literal("sample"),
				Type.Literal("boundary"),
				Type.Literal("random"),
				Type.Literal("stress"),
			]),
			input: Type.Optional(Type.String({ description: "Manual input; empty string for no-input problems" })),
			generatorArgs: Type.Optional(
				Type.Array(Type.String(), {
					description: "Generator argv including a fixed seed; mutually exclusive with input",
					minItems: 1,
				}),
			),
			expectedOutput: Type.Optional(
				Type.String({
					description: "Known sample answer, if complete; all final answers are computed by the reference",
				}),
			),
			oracle: Type.Optional(
				Type.Boolean({ description: "Run independent oracle on small or otherwise affordable instances" }),
			),
			timeLimitMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 10000 })),
			memoryLimitMb: Type.Optional(Type.Integer({ minimum: 32, maximum: 512 })),
		}),
		{ minItems: 1, maxItems: 300 },
	),
	invalidInputs: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 100,
		description: "Out-of-range or malformed inputs the validator must reject",
	}),
	checkerProbes: Type.Optional(
		Type.Array(
			Type.Object({
				caseId: Type.String(),
				output: Type.String(),
				accept: Type.Boolean(),
				score: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
				description: Type.String(),
			}),
			{
				maxItems: 100,
				description: "For SPJ: alternate correct answers AND malformed/incorrect answers with expected verdicts",
			},
		),
	),
	wrongPrograms: Type.Array(
		Type.Object({
			name: Type.String(),
			program: programSchema,
			maxScore: Type.Optional(Type.Integer({ minimum: 0, maximum: 99 })),
		}),
		{
			minItems: 1,
			maxItems: 10,
		},
	),
	timeLimitMs: Type.Integer({ minimum: 50, maximum: 10000 }),
	memoryLimitMb: Type.Integer({ minimum: 32, maximum: 512 }),
	analysis: Type.String({
		minLength: 1,
		description:
			"Algorithm proof, oracle independence, input constraints, generator modes/seed plan, boundary/stress coverage and checker semantics",
	}),
});

export const authoringProjectPatchSchema = Type.Object(
	{
		type: Type.Optional(authoringProjectSchema.properties.type),
		multiPass: Type.Optional(authoringProjectSchema.properties.multiPass),
		answerMode: Type.Optional(authoringProjectSchema.properties.answerMode),
		reference: Type.Optional(programSchema),
		oracle: Type.Optional(programSchema),
		generator: Type.Optional(cppSource),
		validator: Type.Optional(cppSource),
		checker: Type.Optional(Type.Union([cppSource, Type.Null()])),
		interactor: Type.Optional(Type.Union([cppSource, Type.Null()])),
		queryLimitProbe: Type.Optional(programSchema),
		cases: Type.Optional(authoringProjectSchema.properties.cases),
		invalidInputs: Type.Optional(authoringProjectSchema.properties.invalidInputs),
		checkerProbes: Type.Optional(Type.Union([authoringProjectSchema.properties.checkerProbes, Type.Null()])),
		wrongPrograms: Type.Optional(authoringProjectSchema.properties.wrongPrograms),
		timeLimitMs: Type.Optional(authoringProjectSchema.properties.timeLimitMs),
		memoryLimitMb: Type.Optional(authoringProjectSchema.properties.memoryLimitMb),
		analysis: Type.Optional(authoringProjectSchema.properties.analysis),
	},
	{ minProperties: 1 },
);
