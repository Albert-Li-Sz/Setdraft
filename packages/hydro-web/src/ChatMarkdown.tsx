import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
	return (
		<div className="manual-chat-markdown">
			<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
				{content}
			</ReactMarkdown>
		</div>
	);
});
