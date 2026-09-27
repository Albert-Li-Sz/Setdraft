import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { highlightCode } from "./code-language.ts";

const components: Components = {
	code({ className, children, node: _node, ...props }) {
		const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
		return (
			<code className={className} {...props}>
				{language && typeof children === "string"
					? highlightCode(children, language).map((token) =>
							token.className ? (
								<span className={token.className} key={token.from}>
									{token.text}
								</span>
							) : (
								token.text
							),
						)
					: children}
			</code>
		);
	},
};

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
	return (
		<div className="manual-chat-markdown">
			<ReactMarkdown components={components} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
				{content}
			</ReactMarkdown>
		</div>
	);
});
