import type { CompileContext, Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Code, Construct, Extension, State, Token, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
	interface TokenTypeMap {
		setdraftLatexMathFlow: "setdraftLatexMathFlow";
		setdraftLatexMathText: "setdraftLatexMathText";
		setdraftLatexMathData: "setdraftLatexMathData";
		setdraftLatexMathMarker: "setdraftLatexMathMarker";
	}
}

const lineEnding = (code: Code) => code === -5 || code === -4 || code === -3;

/** Recognize LaTeX delimiters before CommonMark treats their backslashes as escapes. */
function mathConstruct(flow: boolean): Construct {
	const type = flow ? "setdraftLatexMathFlow" : "setdraftLatexMathText";
	const tokenize: Tokenizer = function (effects, ok, nok) {
		const context = this;
		let closing = 0;
		const close: Construct = {
			partial: true,
			tokenize(effects, ok, nok) {
				return start;
				function start(code: Code): ReturnType<State> {
					effects.enter("setdraftLatexMathMarker");
					effects.consume(code);
					return end;
				}
				function end(code: Code): ReturnType<State> {
					if (code !== closing) return nok(code);
					effects.consume(code);
					effects.exit("setdraftLatexMathMarker");
					return after;
				}
				function after(code: Code): ReturnType<State> {
					if (!flow || code === null || lineEnding(code)) return ok(code);
					if (code !== 32 && code !== -2 && code !== -1) return nok(code);
					effects.enter("whitespace");
					effects.consume(code);
					effects.exit("whitespace");
					return after;
				}
			},
		};
		return start;
		function start(code: Code): ReturnType<State> {
			effects.enter(type);
			effects.enter("setdraftLatexMathMarker");
			effects.consume(code);
			return open;
		}
		function open(code: Code): ReturnType<State> {
			if (code !== 91 && (flow || code !== 40)) return nok(code);
			// Image alt text is plain text; CommonMark must retain its bracket escapes.
			if (
				!flow &&
				context.events.some(
					([event, token]) => event === "enter" && token.type === "labelImage" && !token._balanced,
				)
			)
				return nok(code);
			closing = code === 91 ? 93 : 41;
			effects.consume(code);
			effects.exit("setdraftLatexMathMarker");
			return between;
		}
		function between(code: Code): ReturnType<State> {
			if (code === null) return nok(code);
			if (lineEnding(code)) {
				effects.enter("lineEnding");
				effects.consume(code);
				effects.exit("lineEnding");
				return between;
			}
			if (code === 92) return effects.attempt(close, finish, escaped)(code);
			effects.enter("setdraftLatexMathData");
			return body(code);
		}
		function body(code: Code): ReturnType<State> {
			if (code === null || code === 92 || lineEnding(code)) {
				effects.exit("setdraftLatexMathData");
				return between(code);
			}
			effects.consume(code);
			return body;
		}
		function escaped(code: Code): ReturnType<State> {
			effects.enter("setdraftLatexMathData");
			effects.consume(code);
			return escapedCharacter;
		}
		function escapedCharacter(code: Code): ReturnType<State> {
			if (code === null) return nok(code);
			if (code === (closing === 93 ? 91 : 40)) return nok(code);
			if (lineEnding(code)) return body(code);
			effects.consume(code);
			return body;
		}
		function finish(code: Code): ReturnType<State> {
			effects.exit(type);
			return ok(code);
		}
	};
	return { name: type, concrete: flow, tokenize };
}

function enterMath(this: CompileContext, token: Token): void {
	this.enter({ type: token.type === "setdraftLatexMathFlow" ? "math" : "inlineMath", value: "" }, token);
	this.buffer();
}

function exitMath(this: CompileContext, token: Token): void {
	const value = this.resume();
	const node = this.stack.at(-1);
	if (node?.type !== "math" && node?.type !== "inlineMath") throw new Error("Invalid LaTeX math node.");
	node.value = node.type === "math" ? value.replace(/^(?:\r\n|\r|\n)|(?:\r\n|\r|\n)$/gu, "") : value;
	const display = node.type === "math" || this.sliceSerialize(token).startsWith("\\[");
	const properties = { className: ["language-math", display ? "math-display" : "math-inline"] };
	const children = [{ type: "text" as const, value: node.value }];
	node.data =
		node.type === "math"
			? { hName: "pre", hChildren: [{ type: "element", tagName: "code", properties, children }] }
			: { hName: "code", hProperties: properties, hChildren: children };
	this.exit(token);
}

/** Native tokens preserve source positions, code blocks, URLs and the existing dollar-math parser. */
export function remarkLatexMath(this: Processor): void {
	const syntax: Extension = { flow: { 92: mathConstruct(true) }, text: { 92: mathConstruct(false) } };
	const nodes: FromMarkdownExtension = {
		enter: { setdraftLatexMathFlow: enterMath, setdraftLatexMathText: enterMath },
		exit: {
			setdraftLatexMathFlow: exitMath,
			setdraftLatexMathText: exitMath,
			setdraftLatexMathData(token) {
				this.config.enter.data.call(this, token);
				this.config.exit.data.call(this, token);
			},
		},
	};
	const data = this.data();
	data.micromarkExtensions ??= [];
	data.fromMarkdownExtensions ??= [];
	data.micromarkExtensions.push(syntax);
	data.fromMarkdownExtensions.push(nodes);
}
