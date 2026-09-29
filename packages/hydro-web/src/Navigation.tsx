import { Icon } from "./Icon.tsx";
import { useLocale } from "./i18n.tsx";
import type { PageRoute } from "./platform.ts";

export const pageLabels: Record<PageRoute, string> = {
	workspace: "制题工作台",
	chat: "AI 对话",
	records: "题目中心",
	contests: "竞赛",
	tasks: "任务",
	settings: "个人设置",
	admin: "管理员设置",
	"authoring-guide": "出题文档",
};
const navigation = [
	{ page: "workspace", icon: "grid" },
	{ page: "chat", icon: "chat" },
	{ page: "records", icon: "files" },
	{ page: "contests", icon: "layers" },
	{ page: "tasks", icon: "activity" },
] as const;

export function Navigation({
	page,
	taskRunning,
	onNavigate,
}: {
	page: PageRoute;
	taskRunning: boolean;
	onNavigate(): void;
}) {
	const { t } = useLocale();
	return (
		<nav className="sidebar-nav" aria-label={t("主导航")}>
			{navigation.map((item) => (
				<a
					key={item.page}
					className={page === item.page ? "active" : ""}
					href={`#${item.page}`}
					onClick={onNavigate}
					aria-current={page === item.page ? "page" : undefined}
				>
					<Icon name={item.icon} />
					<span>{t(pageLabels[item.page])}</span>
					{item.page === "tasks" && taskRunning && (
						<span className="sidebar-task-dot" role="img" aria-label={t("进行中")} />
					)}
				</a>
			))}
		</nav>
	);
}
