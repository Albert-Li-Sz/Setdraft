import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ProjectSnapshot } from "./platform.ts";
import { statementWithSamples } from "./problem.ts";

type PreviewProject = Pick<ProjectSnapshot, "statement" | "samples" | "attachments">;

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

const attachmentMimeTypes: Readonly<Record<string, string>> = {
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
	pdf: "application/pdf",
	txt: "text/plain",
};

export function ProblemPreview({ project }: { project: PreviewProject }) {
	const attachments = new Map(project.attachments.map((item) => [item.name, item.contentBase64]));
	return (
		<div className="problem-preview">
			<ReactMarkdown
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
				urlTransform={(url, _key, node) => {
					if (!url.startsWith("file://")) return defaultUrlTransform(url);
					const name = url.slice("file://".length);
					const content = attachments.get(name);
					if (content === undefined) return null;
					const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
					const mimeType = attachmentMimeTypes[extension] ?? "application/octet-stream";
					if (node.tagName === "img" && !mimeType.startsWith("image/")) return null;
					return `data:${mimeType};base64,${content}`;
				}}
			>
				{statementWithSamples(project)}
			</ReactMarkdown>
		</div>
	);
}
