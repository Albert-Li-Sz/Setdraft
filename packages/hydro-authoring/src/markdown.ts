import type { Definition, Image, ImageReference, Link, LinkReference, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { type PluggableList, unified } from "unified";

export type MarkdownProfile = "statement" | "chat" | "guide";
export interface MarkdownDiagnostic {
	code:
		| "MARKDOWN_COMPLEXITY_LIMIT"
		| "MARKDOWN_PROCESSING_FAILED"
		| "UNSAFE_MARKDOWN_URL"
		| "INVALID_ATTACHMENT_REFERENCE";
	severity: "error";
	message: string;
	position?: RootContent["position"];
}
export class MarkdownProcessingError extends Error {
	readonly diagnostic: MarkdownDiagnostic;
	constructor(diagnostic: MarkdownDiagnostic) {
		super(diagnostic.message);
		this.name = "MarkdownProcessingError";
		this.diagnostic = diagnostic;
	}
}
const richPlugins: PluggableList = [remarkGfm, remarkMath];
const guidePlugins: PluggableList = [remarkGfm];
export function markdownRemarkPlugins(profile: MarkdownProfile): PluggableList {
	return profile === "guide" ? guidePlugins : richPlugins;
}
const parsers = {
	statement: unified().use(remarkParse).use(richPlugins),
	chat: unified().use(remarkParse).use(richPlugins),
	guide: unified().use(remarkParse).use(guidePlugins),
};

export function walkMarkdown(tree: Root, visit: (node: RootContent) => void): void {
	let count = 0;
	const walk = (node: RootContent, depth: number): void => {
		if (++count > 30_000 || depth > 80)
			throw new MarkdownProcessingError({
				code: "MARKDOWN_COMPLEXITY_LIMIT",
				severity: "error",
				message: "Markdown 结构过于复杂，请简化嵌套或拆分内容。",
				position: node.position,
			});
		visit(node);
		if ("children" in node) for (const child of node.children) walk(child, depth + 1);
	};
	for (const node of tree.children) walk(node, 0);
}

export function parseMarkdown(markdown: string, profile: MarkdownProfile = "statement"): Root {
	const tree = parsers[profile].parse(markdown);
	walkMarkdown(tree, () => {});
	return tree;
}

const serializer = unified().use(richPlugins).use(remarkStringify);
export function serializeMarkdown(tree: Root): string {
	return serializer.stringify(tree);
}

/** The destination has already been decoded by CommonMark; suffixes do not name files. */
export function markdownAttachmentName(url: string): string | undefined {
	if (!/^file:\/\//iu.test(url)) return undefined;
	const name = url.slice(7).split(/[?#]/u)[0];
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) && name !== "." && name !== ".." ? name : undefined;
}

/** CommonMark destinations are decoded by the parser; definitions use document-wide first-wins semantics. */
export function collectMarkdownReferences(
	tree: Root,
): Array<{ node: Image | ImageReference | Link | LinkReference; url: string; title?: string | null }> {
	const definitions = new Map<string, Definition>();
	const nodes: RootContent[] = [];
	walkMarkdown(tree, (node) => {
		nodes.push(node);
		if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
	});
	const references: ReturnType<typeof collectMarkdownReferences> = [];
	for (const node of nodes) {
		if (node.type === "image" || node.type === "link") references.push({ node, url: node.url, title: node.title });
		else if (node.type === "imageReference" || node.type === "linkReference") {
			const definition = definitions.get(node.identifier);
			if (definition) references.push({ node, url: definition.url, title: definition.title });
		}
	}
	return references;
}

export function markdownReferences(markdown: string): ReturnType<typeof collectMarkdownReferences> {
	return collectMarkdownReferences(parseMarkdown(markdown));
}

/** The same safe protocols as react-markdown, with explicit rejection of control characters. */
export function safeMarkdownUrl(url: string): string | undefined {
	if (/[\u0000-\u001f\u007f]/u.test(url)) return undefined;
	const colon = url.indexOf(":");
	if (
		colon < 0 ||
		["/", "?", "#"].some((separator) => {
			const index = url.indexOf(separator);
			return index >= 0 && index < colon;
		})
	)
		return url;
	return /^(https?|ircs?|irc6|mailto|xmpp)$/iu.test(url.slice(0, colon)) ? url : undefined;
}

export function markdownDiagnostics(tree: Root, profile: MarkdownProfile = "statement"): MarkdownDiagnostic[] {
	const diagnostics: MarkdownDiagnostic[] = [];
	for (const { node, url } of collectMarkdownReferences(tree)) {
		if (profile === "statement" && /^file:\/\//iu.test(url)) {
			if (!markdownAttachmentName(url))
				diagnostics.push({
					code: "INVALID_ATTACHMENT_REFERENCE",
					severity: "error",
					message: "附件引用须使用已上传的平面文件名。",
					position: node.position,
				});
		} else if (safeMarkdownUrl(url) === undefined)
			diagnostics.push({
				code: "UNSAFE_MARKDOWN_URL",
				severity: "error",
				message: "链接使用了不支持的协议。",
				position: node.position,
			});
	}
	return diagnostics;
}

/** Non-throwing boundary for publication and export validation reports. */
export function inspectMarkdown(source: string, profile: MarkdownProfile = "statement") {
	try {
		const tree = parseMarkdown(source, profile);
		return { references: collectMarkdownReferences(tree), diagnostics: markdownDiagnostics(tree, profile) };
	} catch (error) {
		return {
			references: [],
			diagnostics: [
				error instanceof MarkdownProcessingError
					? error.diagnostic
					: {
							code: "MARKDOWN_PROCESSING_FAILED" as const,
							severity: "error" as const,
							message: "Markdown 处理失败，请简化内容后重试。",
						},
			],
		};
	}
}

/** Split top-level headings only; prepend first-wins definitions from the logical document. */
export function splitMarkdownSections(source: string): {
	introduction: string;
	sections: Array<{ title: string; body: string }>;
} {
	const tree = parseMarkdown(source, "guide");
	const headings = tree.children.filter((node) => node.type === "heading" && node.depth === 2);
	const definitions = new Map<string, string>();
	walkMarkdown(tree, (node) => {
		if ((node.type === "definition" || node.type === "footnoteDefinition") && node.position) {
			const key = `${node.type}:${node.identifier}`;
			if (!definitions.has(key))
				definitions.set(key, source.slice(node.position.start.offset, node.position.end.offset));
		}
	});
	const prefix = [...definitions.values()].join("\n\n");
	const complete = (text: string) => `${prefix}\n\n${text.trim()}`.trim();
	const first = tree.children[0];
	const introStart = first?.type === "heading" && first.depth === 1 ? (first.position?.end.offset ?? 0) : 0;
	const text = (node: RootContent): string => {
		if ("value" in node) return node.value;
		if ("children" in node) return node.children.map(text).join("");
		if ("alt" in node) return node.alt ?? "";
		return "";
	};
	return {
		introduction: complete(source.slice(introStart, headings[0]?.position?.start.offset)),
		sections: headings.map((heading, index) => ({
			title: text(heading).trim(),
			body: complete(source.slice(heading.position?.end.offset, headings[index + 1]?.position?.start.offset)),
		})),
	};
}
