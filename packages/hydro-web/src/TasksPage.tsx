import { useEffect, useRef, useState } from "react";
import { requestJson } from "./api-client.ts";
import { authClient } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Icon } from "./Icon.tsx";
import { useLocale } from "./i18n.tsx";
import { apiUrl, type BackgroundTask, type TaskEvent } from "./platform.ts";

import { workspaceHash } from "./workspace-navigation.ts";

function checkDetails(data: unknown): { caseId?: string; passed?: boolean } {
	if (typeof data !== "object" || data === null) return {};
	return {
		caseId: "caseId" in data && typeof data.caseId === "string" ? data.caseId : undefined,
		passed: "passed" in data && typeof data.passed === "boolean" ? data.passed : undefined,
	};
}

const taskNames: Record<BackgroundTask["kind"], string> = {
	matrix: "验证矩阵",
	stress: "随机对拍",
	generate: "生成数据",
	finalize: "完整验证与打包",
	"contest-export": "竞赛导出",
	"release-export": "发布包导出",
	"image-build": "构建沙箱镜像",
};

const stateNames: Record<BackgroundTask["state"], string> = {
	queued: "等待中",
	running: "进行中",
	succeeded: "已完成",
	failed: "失败",
	cancelled: "已取消",
	stale: "题目已变化",
	interrupted: "服务中断",
};

function TaskState({ state, cleanupPending }: { state: BackgroundTask["state"]; cleanupPending?: boolean }) {
	const { t } = useLocale();
	const active = state === "running" || state === "queued";
	return (
		<span className={`status-badge ${active ? "is-active" : state === "succeeded" ? "online" : "offline"}`}>
			<Icon
				name={active ? "loader" : state === "succeeded" ? "check" : "close"}
				className={active ? "loading-icon" : undefined}
			/>
			{t(cleanupPending ? "停止未确认" : stateNames[state])}
		</span>
	);
}

function QueueStatus({ task, detail = false }: { task: BackgroundTask; detail?: boolean }) {
	const { t, locale } = useLocale();
	if (task.state !== "queued" || !task.queue) return null;
	const queue = task.queue;
	const reasons = {
		user: "等待本账号前序任务",
		maintenance: "等待沙箱维护窗口",
		capacity: "等待空闲执行名额",
		dispatch: "正在分配执行环境",
	};
	return (
		<span className="task-queue-status">
			<span>
				{t("个人队列第 {0} 项", queue.position)} · {t(reasons[queue.reason])}
			</span>
			{detail && (
				<span>
					{t(
						"全站运行 {0} / {1} · 排队截止 {2}",
						queue.running,
						queue.concurrency,
						new Date(queue.expiresAt).toLocaleTimeString(locale),
					)}
				</span>
			)}
		</span>
	);
}

export function TasksPage({ apiOrigin, paused }: { apiOrigin: string; paused: boolean }) {
	const { t, locale } = useLocale();
	const [tasks, setTasks] = useState<BackgroundTask[]>([]);
	const [selected, setSelected] = useState<string>();
	const [events, setEvents] = useState<TaskEvent[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	// A newer pending poll must not discard a healthy response that has already arrived.
	const refreshRevision = useRef(0);
	const requestRevision = useRef(0);
	const viewRevision = useRef(0);
	const actionPending = useRef(false);

	useEffect(() => {
		++viewRevision.current;
		actionPending.current = false;
		setBusy(false);
		if (paused) return;
		let active = true;
		const controller = new AbortController();
		const refresh = async () => {
			const revision = ++requestRevision.current;
			try {
				const body = await requestJson<{ tasks: BackgroundTask[] }>(apiUrl(apiOrigin, "/tasks"), {
					signal: controller.signal,
				});
				if (active && revision > refreshRevision.current) {
					refreshRevision.current = revision;
					setTasks(body.tasks ?? []);
					setError("");
				}
			} catch (cause) {
				if (active && revision > refreshRevision.current) {
					refreshRevision.current = revision;
					setError(cause instanceof Error ? cause.message : "任务读取失败。");
				}
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 2000);
		return () => {
			active = false;
			++viewRevision.current;
			controller.abort();
			clearInterval(timer);
		};
	}, [apiOrigin, paused]);

	useEffect(() => {
		if (!selected || paused) return;
		setEvents([]);
		const source = new EventSource(apiUrl(apiOrigin, `/tasks/${selected}/events`));
		source.onerror = () => {
			void authClient.refresh();
		};
		const receive = (event: MessageEvent<string>) => {
			const item = JSON.parse(event.data) as TaskEvent;
			setEvents((current) =>
				current.some((entry) => entry.sequence === item.sequence) ? current : [...current, item],
			);
			if (["succeeded", "failed", "cancelled", "stale", "interrupted"].includes(item.type)) source.close();
		};
		for (const type of [
			"queued",
			"running",
			"stage",
			"check",
			"log",
			"succeeded",
			"failed",
			"cancelled",
			"stale",
			"interrupted",
			"cancelling",
			"cleanup-pending",
		])
			source.addEventListener(type, receive as EventListener);
		return () => source.close();
	}, [apiOrigin, selected, paused]);

	async function action(kind: "cancel" | "retry"): Promise<void> {
		if (!selected || paused || actionPending.current) return;
		const view = viewRevision.current;
		actionPending.current = true;
		refreshRevision.current = ++requestRevision.current;
		setBusy(true);
		try {
			const body = await requestJson<BackgroundTask | { task: BackgroundTask }>(
				apiUrl(apiOrigin, `/tasks/${selected}/${kind}`),
				{
					method: "POST",
				},
			);
			if (view !== viewRevision.current) return;
			const updated = "task" in body ? body.task : body;
			refreshRevision.current = ++requestRevision.current;
			setTasks((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
			setSelected(updated.id);
			setError("");
		} catch (cause) {
			if (view !== viewRevision.current) return;
			refreshRevision.current = ++requestRevision.current;
			setError(cause instanceof Error ? cause.message : "操作失败。");
		} finally {
			if (view === viewRevision.current) {
				actionPending.current = false;
				setBusy(false);
			}
		}
	}

	const task = tasks.find((item) => item.id === selected);
	const groups = new Map<string, BackgroundTask[]>();
	for (const item of tasks) groups.set(item.resource, [...(groups.get(item.resource) ?? []), item]);
	return (
		<main className="page tasks-page" id="tasks">
			<section className="page-heading">
				<div>
					<h1>{t("任务状态")}</h1>
					<p>{t("离开制题页面后，生成、验证和导出仍会继续。")}</p>
				</div>
			</section>
			{error && (
				<output className="notice failed" role="alert">
					{t(error)}
				</output>
			)}
			<section className="task-groups" aria-label={t("任务列表")}>
				{!tasks.length && (
					<EmptyState
						icon="activity"
						title={t("任务状态")}
						description={t("暂无任务。运行 Gen 或验证打包后会显示在这里。")}
					/>
				)}
				{[...groups].map(([resource, items]) => (
					<section className="card task-group" key={resource}>
						<div className="task-group-heading">
							<h2>{items[0].resourceTitle || (resource === "image" ? t("系统任务") : resource)}</h2>
							<span>{t("{0} 次任务", items.length)}</span>
						</div>
						{items.map((item) => (
							<button className="task-row" key={item.id} type="button" onClick={() => setSelected(item.id)}>
								<span>
									<strong>
										{t(taskNames[item.kind])}
										{item.releaseName ? ` · ${item.releaseName}` : ""}
									</strong>
									<small>
										{new Date(item.createdAt).toLocaleString(locale)} · {item.id.slice(0, 8)}
									</small>
									<QueueStatus task={item} />
								</span>
								<TaskState state={item.state} cleanupPending={item.cleanupPending} />
							</button>
						))}
					</section>
				))}
			</section>
			<Dialog
				open={!!selected}
				onClose={() => setSelected(undefined)}
				labelledBy="task-detail-title"
				className="task-detail-dialog"
			>
				<section className="tasks-detail">
					{task ? (
						<>
							<div className="tasks-detail-head">
								<div>
									<div className="eyebrow">{task.kind}</div>
									<h2 id="task-detail-title">{t(taskNames[task.kind])}</h2>
									<p>
										{task.resourceTitle} · {new Date(task.createdAt).toLocaleString(locale)}
									</p>
									<TaskState state={task.state} cleanupPending={task.cleanupPending} />
									<QueueStatus task={task} detail />
								</div>
								<div className="heading-actions">
									<button className="button secondary" type="button" onClick={() => setSelected(undefined)}>
										{t("关闭")}
									</button>
									{["queued", "running"].includes(task.state) && (
										<button
											className="button secondary"
											type="button"
											disabled={busy || task.cleanupPending}
											onClick={() => void action("cancel")}
										>
											{t("取消任务")}
										</button>
									)}
									{["failed", "cancelled", "stale", "interrupted"].includes(task.state) && (
										<button
											className="button primary"
											type="button"
											disabled={busy}
											onClick={() => void action("retry")}
										>
											{t("重试")}
										</button>
									)}
								</div>
							</div>
							{["matrix", "stress", "finalize"].includes(task.kind) && (
								<a
									className="button secondary button-link"
									href={workspaceHash({
										project: task.resource.split(":")[1],
										tab: "validation",
										task: task.id,
										mode: task.kind === "stress" ? "stress" : "matrix",
									})}
								>
									{t("打开对应运行")}
								</a>
							)}
							{task.error && <p className="tasks-error">{t(task.error)}</p>}
							<div className="tasks-events" role="log" aria-live="polite">
								{events.map((item) => {
									const details = checkDetails(item.data);
									return (
										<div
											key={item.sequence}
											className={`tasks-event ${details.passed === false ? "failed" : ""}`}
										>
											<time>{new Date(item.createdAt).toLocaleTimeString(locale)}</time>
											<span>
												{details.caseId ? `#${details.caseId} · ` : ""}
												{t(item.message)}
											</span>
										</div>
									);
								})}
							</div>
						</>
					) : (
						<div className="tasks-empty">{t("选择任务查看运行日志与验证进度。")}</div>
					)}
				</section>
			</Dialog>
		</main>
	);
}
