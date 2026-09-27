import { type ComponentProps, memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { highlightCode } from "./code-language.ts";
import { Icon } from "./Icon.tsx";
import { useLocale } from "./i18n.tsx";

function ChatCodeBlock({
	code,
	language,
	children,
	...props
}: ComponentProps<"pre"> & { code: string; language?: string }) {
	const { t } = useLocale();
	const [copied, setCopied] = useState<string>();
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (copied === undefined) return;
		const timer = setTimeout(() => setCopied(undefined), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="chat-code-block">
			<div className="chat-code-toolbar">
				<span>{language || t("代码")}</span>
				<button
					type="button"
					aria-label={t("复制代码")}
					onClick={() => {
						setFailed(false);
						void (async () => {
							try {
								await navigator.clipboard.writeText(code);
								setCopied(code);
							} catch {
								setFailed(true);
							}
						})();
					}}
				>
					<Icon name={copied === code ? "check" : "files"} />
					<span aria-live="polite">{t(copied === code ? "已复制" : "复制代码")}</span>
				</button>
			</div>
			{failed && <p role="alert">{t("复制失败，请检查浏览器剪贴板权限。")}</p>}
			<pre {...props}>{children}</pre>
		</div>
	);
}

const components: Components = {
	pre({ node, children, ...props }) {
		const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
		if (code?.type !== "element") return <pre {...props}>{children}</pre>;
		const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
		const classes = code.properties.className;
		const language = Array.isArray(classes)
			? classes.find((value) => typeof value === "string" && value.startsWith("language-"))
			: undefined;
		return (
			<ChatCodeBlock code={text} language={typeof language === "string" ? language.slice(9) : undefined} {...props}>
				{children}
			</ChatCodeBlock>
		);
	},
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
