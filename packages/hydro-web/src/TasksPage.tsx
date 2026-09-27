import { useEffect, useState } from "react";
import { requestJson } from "./api-client.ts";
import { useLocale } from "./i18n.tsx";
import { apiUrl, type BackgroundTask, type TaskEvent } from "./platform.ts";

function checkDetails(data: unknown): { caseId?: string; passed?: boolean } {
	if (typeof data !== "object" || data === null) return {};
	return {
		caseId: "caseId" in data && typeof data.caseId === "string" ? data.caseId : undefined,
		passed: "passed" in data && typeof data.passed === "boolean" ? data.passed : undefined,
	};
}

const taskNames: Record<BackgroundTask["kind"], string> = {
	generate: "生成数据",
	finalize: "完整验证与打包",
	"contest-export": "竞赛导出",
	"image-build": "构建沙箱镜像",
};

const stateNames: Record<BackgroundTask["state"], string> = {
	queued: "等待中",
	running: "进行中",
	succeeded: "已完成",
	failed: "失败",
	cancelled: "已取消",
	stale: "草稿已变化",
	interrupted: "服务中断",
};

export function TasksPage({ apiOrigin }: { apiOrigin: string }) {
	const { t, locale } = useLocale();
	const [tasks, setTasks] = useState<BackgroundTask[]>([]);
	const [selected, setSelected] = useState<string>();
	const [events, setEvents] = useState<TaskEvent[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let active = true;
		const controller = new AbortController();
		const refresh = async () => {
			try {
				const body = await requestJson<{ tasks: BackgroundTask[] }>(apiUrl(apiOrigin, "/tasks"), {
					signal: controller.signal,
				});
				if (active) {
					setTasks(body.tasks ?? []);
					setSelected((current) => current ?? body.tasks?.[0]?.id);
				}
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : "任务读取失败。");
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 2000);
		return () => {
			active = false;
			controller.abort();
			clearInterval(timer);
		};
	}, [apiOrigin]);

	useEffect(() => {
		if (!selected) return;
		setEvents([]);
		const source = new EventSource(apiUrl(apiOrigin, `/tasks/${selected}/events`));
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
		])
			source.addEventListener(type, receive as EventListener);
		return () => source.close();
	}, [apiOrigin, selected]);

	async function action(kind: "cancel" | "retry"): Promise<void> {
		if (!selected) return;
		setBusy(true);
		try {
			const body = await requestJson<{ task: BackgroundTask }>(apiUrl(apiOrigin, `/tasks/${selected}/${kind}`), {
				method: "POST",
			});
			if (body.task) setSelected(body.task.id);
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "操作失败。");
		} finally {
			setBusy(false);
		}
	}

	const task = tasks.find((item) => item.id === selected);
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
			<div className="tasks-layout">
				<aside className="card tasks-list" aria-label={t("任务列表")}>
					{tasks.length === 0 ? (
						<div className="tasks-empty">{t("暂无任务。运行 Gen 或验证打包后会显示在这里。")}</div>
					) : (
						tasks.map((item) => (
							<button
								key={item.id}
								className={selected === item.id ? "active" : ""}
								type="button"
								onClick={() => setSelected(item.id)}
							>
								<span>{t(taskNames[item.kind])}</span>
								<small>
									{t(stateNames[item.state])} · {new Date(item.createdAt).toLocaleString(locale)}
								</small>
							</button>
						))
					)}
				</aside>
				<section className="card tasks-detail">
					{task ? (
						<>
							<div className="tasks-detail-head">
								<div>
									<div className="eyebrow">{task.kind}</div>
									<h2>{t(taskNames[task.kind])}</h2>
									<span
										className={`status-badge ${task.state === "succeeded" ? "online" : task.state === "failed" ? "offline" : ""}`}
									>
										{t(stateNames[task.state])}
									</span>
								</div>
								<div className="heading-actions">
									{["queued", "running"].includes(task.state) && (
										<button
											className="button secondary"
											type="button"
											disabled={busy}
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
												{item.message}
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
			</div>
		</main>
	);
}
