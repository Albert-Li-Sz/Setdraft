import type { Definition, Image, ImageReference, Link, LinkReference, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** CommonMark destinations are decoded by the parser; definitions use document-wide first-wins semantics. */
export function markdownReferences(
	markdown: string,
): Array<{ node: Image | ImageReference | Link | LinkReference; url: string; title?: string | null }> {
	const tree = parser.parse(markdown);
	const definitions = new Map<string, Definition>();
	const nodes: RootContent[] = [];
	const visit = (node: RootContent, depth: number): void => {
		if (nodes.length >= 30_000 || depth > 80) throw new Error("Markdown 结构过于复杂，请简化嵌套或拆分内容。");
		nodes.push(node);
		if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
		if ("children" in node) for (const child of node.children) visit(child, depth + 1);
	};
	for (const node of tree.children) visit(node, 0);
	const references: ReturnType<typeof markdownReferences> = [];
	for (const node of nodes) {
		if (node.type === "image" || node.type === "link") references.push({ node, url: node.url, title: node.title });
		else if (node.type === "imageReference" || node.type === "linkReference") {
			const definition = definitions.get(node.identifier);
			if (definition) references.push({ node, url: definition.url, title: definition.title });
		}
	}
	return references;
}
