import type { AuthUser } from "@setdraft/contracts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccountControls } from "./AccountControls.tsx";
import { Icon } from "./Icon.tsx";
import { LocaleSwitcher, useLocale } from "./i18n.tsx";
import { Navigation, pageLabels } from "./Navigation.tsx";
import type { PageRoute, ProjectSnapshot } from "./platform.ts";
import { ThemeSwitcher } from "./theme.tsx";
import { appVersion } from "./version.ts";

const SidebarContext = createContext<{ target: HTMLDivElement | null; close(): void }>({ target: null, close() {} });
export const useAppSidebar = () => useContext(SidebarContext);

function readCollapsed(): boolean {
	try {
		return localStorage.getItem("setdraft.sidebar-collapsed") === "true";
	} catch {
		return false;
	}
}

export function AppShell({
	user,
	onLogout,
	children,
	page,
	projects,
	currentProjectId,
	busy,
	taskRunning,
	onNew,
	onOpen,
}: {
	user: AuthUser;
	onLogout(): Promise<void>;
	children: ReactNode;
	page: PageRoute;
	projects: ProjectSnapshot[];
	currentProjectId?: string;
	busy: boolean;
	taskRunning: boolean;
	onNew(): void;
	onOpen(id: string): Promise<void>;
}) {
	const { t } = useLocale();
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 760px)").matches);
	const [mobileOpen, setMobileOpen] = useState(false);
	const [target, setTarget] = useState<HTMLDivElement | null>(null);
	const drawer = useRef<HTMLDialogElement>(null);
	const close = useCallback(() => setMobileOpen(false), []);
	const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
	useEffect(() => {
		const media = window.matchMedia("(max-width: 760px)");
		const update = () => {
			setCompact(media.matches);
			setMobileOpen(false);
		};
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		const dialog = drawer.current;
		if (!compact || !dialog) return;
		if (mobileOpen && !dialog.open) dialog.showModal();
		else if (!mobileOpen && dialog.open) dialog.close();
	}, [mobileOpen, compact]);
	const toggle = () => {
		if (compact) setMobileOpen((current) => !current);
		else {
			setCollapsed(!collapsed);
			try {
				localStorage.setItem("setdraft.sidebar-collapsed", String(!collapsed));
			} catch {
				/* Session preference still applies. */
			}
		}
	};
	const sidebar = (
		<>
			<div className="sidebar-brand-row">
				<a className="sidebar-brand" href="#workspace" aria-label={t("Setdraft 首页")}>
					<span className="brand-mark" aria-hidden="true">
						<Icon name="layers" />
					</span>
					<span>Setdraft</span>
				</a>
				{compact && (
					<button className="icon-button" type="button" onClick={close} aria-label={t("关闭侧栏")}>
						<Icon name="close" />
					</button>
				)}
			</div>
			<button
				className="sidebar-new"
				type="button"
				disabled={busy}
				onClick={() => {
					close();
					onNew();
				}}
			>
				<Icon name="compose" />
				<span>{t("新建题目")}</span>
				<Icon name="plus" />
			</button>
			<Navigation page={page} taskRunning={taskRunning} onNavigate={close} />
			<div className="sidebar-scroll">
				{page !== "chat" && (
					<section className="sidebar-recents" aria-label={t("最近题目")}>
						<h2>{t("最近题目")}</h2>
						{recent.length ? (
							recent.map((project) => (
								<button
									className={`sidebar-project ${currentProjectId === project.id && page === "workspace" ? "active" : ""}`}
									type="button"
									disabled={busy}
									key={project.id}
									title={project.title || t("未命名题目")}
									onClick={() => {
										close();
										void onOpen(project.id);
									}}
								>
									<Icon name="file" />
									<span>{project.title || t("未命名题目")}</span>
								</button>
							))
						) : (
							<p className="sidebar-empty">{t("暂无题目")}</p>
						)}
					</section>
				)}
				<div ref={setTarget} className="sidebar-slot" />
			</div>
			<div className="sidebar-bottom">
				<a className="sidebar-settings" href="/open-source/index.html" target="_blank" rel="noreferrer">
					<Icon name="file" />
					{t("开源与源码")}
				</a>
				<a
					className={`sidebar-settings ${page === "settings" ? "active" : ""}`}
					href="#settings"
					aria-current={page === "settings" ? "page" : undefined}
				>
					<Icon name="settings" />
					{t("个人设置")}
				</a>
				{user.role === "admin" && (
					<a
						className={`sidebar-settings ${page === "admin" ? "active" : ""}`}
						href="#admin"
						aria-current={page === "admin" ? "page" : undefined}
					>
						<Icon name="layers" />
						{t("管理员设置")}
					</a>
				)}
				<AccountControls user={user} onLogout={onLogout} />
			</div>
		</>
	);
	return (
		<SidebarContext.Provider value={{ target, close }}>
			<div className="app-shell" data-collapsed={collapsed && !compact}>
				{compact ? (
					<dialog
						ref={drawer}
						className="app-sidebar sidebar-drawer"
						id="app-sidebar"
						aria-label={t("主导航")}
						onCancel={(event) => {
							event.preventDefault();
							close();
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								close();
							}
						}}
						onClick={(event) => {
							if (event.target instanceof Element && event.target.closest("a[href]")) {
								close();
								return;
							}
							if (event.target !== event.currentTarget) return;
							const bounds = event.currentTarget.getBoundingClientRect();
							if (
								event.clientX < bounds.left ||
								event.clientX > bounds.right ||
								event.clientY < bounds.top ||
								event.clientY > bounds.bottom
							)
								close();
						}}
					>
						{sidebar}
					</dialog>
				) : (
					<aside className="app-sidebar" id="app-sidebar" inert={collapsed}>
						{sidebar}
					</aside>
				)}
				<div className="shell-main">
					<header className="shell-toolbar">
						<button
							className="icon-button sidebar-toggle"
							type="button"
							onClick={toggle}
							aria-controls="app-sidebar"
							aria-expanded={compact ? mobileOpen : !collapsed}
							aria-label={(compact ? mobileOpen : !collapsed) ? t("收起侧栏") : t("展开侧栏")}
							title={(compact ? mobileOpen : !collapsed) ? t("收起侧栏") : t("展开侧栏")}
						>
							<Icon name="panel" />
						</button>
						<span className="shell-page-title">{t(pageLabels[page])}</span>
						<div className="shell-toolbar-tools">
							<a className="toolbar-brand" href="#workspace">
								Setdraft <small>{appVersion}</small>
							</a>
							<ThemeSwitcher />
							<LocaleSwitcher />
						</div>
					</header>
					{children}
				</div>
			</div>
		</SidebarContext.Provider>
	);
}
