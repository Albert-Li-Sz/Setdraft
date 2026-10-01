import {
	type MarkdownProfile,
	markdownRemarkPlugins,
	parseMarkdown,
	safeMarkdownUrl,
} from "@setdraft/authoring/markdown";
import { Component, type ReactNode, useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import { useLocale } from "./i18n.tsx";

const mathPlugins = [rehypeKatex];

class MarkdownBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
export function MarkdownView({
	children,
	profile,
	components,
	urlTransform,
}: {
	children: string;
	profile: MarkdownProfile;
	components?: Options["components"];
	urlTransform?: Options["urlTransform"];
}) {
	const { t } = useLocale();
	const failed = useMemo(() => {
		try {
			parseMarkdown(children, profile);
			return false;
		} catch {
			return true;
		}
	}, [children, profile]);
	const fallback = (
		<>
			<p role="alert">{t("Markdown 处理失败，已显示原始内容。")}</p>
			<pre>{children}</pre>
		</>
	);
	if (failed) return fallback;
	return (
		<MarkdownBoundary key={`${profile}:${children}`} fallback={fallback}>
			<ReactMarkdown
				components={components}
				remarkPlugins={markdownRemarkPlugins(profile)}
				rehypePlugins={profile === "guide" ? [] : mathPlugins}
				urlTransform={urlTransform ?? ((url) => safeMarkdownUrl(url))}
			>
				{children}
			</ReactMarkdown>
		</MarkdownBoundary>
	);
}
