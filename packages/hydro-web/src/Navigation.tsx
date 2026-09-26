import { useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "./i18n.tsx";
import type { PageRoute } from "./platform.ts";

const navigation: ReadonlyArray<{ page: PageRoute; label: string }> = [
	{ page: "workspace", label: "制题工作台" },
	{ page: "chat", label: "AI 对话" },
	{ page: "records", label: "制题记录" },
	{ page: "contests", label: "竞赛" },
	{ page: "tasks", label: "任务" },
	{ page: "settings", label: "设置" },
];

export function Navigation({ page, taskRunning }: { page: PageRoute; taskRunning: boolean }) {
	const { t } = useLocale();
	const navRef = useRef<HTMLElement>(null);
	const [indicator, setIndicator] = useState<{ left: number; width: number }>();
	useLayoutEffect(() => {
		const nav = navRef.current;
		if (!nav) return;
		const measure = () => {
			const active = nav.querySelector<HTMLAnchorElement>(`a[href="#${page}"]`);
			if (!active) return;
			const next = { left: active.offsetLeft, width: active.offsetWidth };
			setIndicator((current) => (current?.left === next.left && current.width === next.width ? current : next));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(nav);
		for (const link of nav.querySelectorAll("a")) observer.observe(link);
		return () => observer.disconnect();
	}, [page]);
	return (
		<nav className="main-nav" ref={navRef} aria-label={t("主导航")}>
			<span
				className="nav-indicator"
				aria-hidden="true"
				style={{
					width: indicator?.width ?? 0,
					transform: `translateX(${indicator?.left ?? 0}px)`,
					opacity: indicator ? 1 : 0,
				}}
			/>
			{navigation.map((item) => (
				<a
					key={item.page}
					className={page === item.page ? "active" : ""}
					href={`#${item.page}`}
					aria-current={page === item.page ? "page" : undefined}
				>
					{t(item.label)}
					{item.page === "tasks" && taskRunning && (
						<span className="nav-task-dot" role="img" aria-label={t("进行中")} />
					)}
				</a>
			))}
		</nav>
	);
}
