import { markdownAttachmentName, safeMarkdownUrl } from "@setdraft/authoring/markdown";
import { formatHydroStatement } from "@setdraft/authoring/statement";
import { MarkdownView } from "./MarkdownView.tsx";
import type { ProjectSnapshot } from "./platform.ts";

type PreviewProject = Pick<
	ProjectSnapshot,
	"statement" | "statementSections" | "judgingMode" | "samples" | "attachments"
>;

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
			<MarkdownView
				profile="statement"
				urlTransform={(url, _key, node) => {
					if (!/^file:\/\//iu.test(url)) return safeMarkdownUrl(url);
					const name = markdownAttachmentName(url);
					if (!name) return null;
					const content = attachments.get(name);
					if (content === undefined) return null;
					const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
					const mimeType = attachmentMimeTypes[extension] ?? "application/octet-stream";
					if (node.tagName === "img" && !mimeType.startsWith("image/")) return null;
					return `data:${mimeType};base64,${content}`;
				}}
			>
				{formatHydroStatement(project)}
			</MarkdownView>
		</div>
	);
}
