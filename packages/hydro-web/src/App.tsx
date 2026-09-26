import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RevisionConflict, requestJson } from "./api-client.ts";
import { Icon } from "./Icon.tsx";
import { LocaleSwitcher, type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
import {
	apiUrl,
	type BackgroundTask,
	type ManualRelease,
	type ManualReport,
	type PageRoute,
	type ProjectSnapshot,
	pageFromHash,
	responseError,
	type SandboxStatus,
	waitForTask,
} from "./platform.ts";
import { projectContextSnapshot } from "./problem.ts";
import { useProjectSession } from "./use-project-session.ts";
import { WorkspaceHome } from "./WorkspaceHome.tsx";

const AiChatPage = lazy(() => import("./AiChatPage.tsx").then((module) => ({ default: module.AiChatPage })));
const ContestsPage = lazy(() => import("./ContestsPage.tsx").then((module) => ({ default: module.ContestsPage })));
const ManualWorkspace = lazy(() =>
	import("./ManualWorkspace.tsx").then((module) => ({ default: module.ManualWorkspace })),
);
const RecordsPage = lazy(() => import("./RecordsPage.tsx").then((module) => ({ default: module.RecordsPage })));
const SettingsPage = lazy(() => import("./SettingsPage.tsx").then((module) => ({ default: module.SettingsPage })));
const TasksPage = lazy(() => import("./TasksPage.tsx").then((module) => ({ default: module.TasksPage })));

const currentProjectKey = "hydro-problem-make.project-id";

export function App() {
	const { t } = useLocale();
	const [page, setPage] = useState<PageRoute>(() => pageFromHash(window.location.hash));
	const apiOrigin = "";
	const selection = useRef<AbortController | undefined>(undefined);
	const [sandbox, setSandbox] = useState<SandboxStatus>();
	const [aiConfigured, setAiConfigured] = useState(false);
	const [choosingScoringMode, setChoosingScoringMode] = useState(false);
	const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
	const [releases, setReleases] = useState<ManualRelease[]>([]);
	const [release, setRelease] = useState<ManualRelease>();
	const [report, setReport] = useState<ManualReport>();
	const [busy, setBusy] = useState<"upload" | "generate" | "finalize">();
	const [activeTask, setActiveTask] = useState<BackgroundTask>();
	const [recordsLoading, setRecordsLoading] = useState(false);
	const [recordsMessage, setRecordsMessage] = useState<UiMessage>("");
	const [recordsTone, setRecordsTone] = useState<"passed" | "failed">("passed");
	const [notice, setNotice] = useState<UiMessage>("草稿自动保存在本地服务端。请添加标准程序与测试数据。");
	const [noticeTone, setNoticeTone] = useState<"pending" | "passed" | "failed">("pending");

	const showNotice = useCallback((message: UiMessage, tone: "pending" | "passed" | "failed" = "pending"): void => {
		setNotice(message);
		setNoticeTone(tone);
	}, []);

	const {
		session,
		project,
		status: sessionStatus,
		conflict: conflictSnapshot,
	} = useProjectSession(apiOrigin, (error) =>
		showNotice(error instanceof Error ? error.message : "草稿保存失败。", "failed"),
	);
	const saveStatus = { saved: "已保存", dirty: "待保存", saving: "正在保存", conflict: "版本冲突", error: "保存失败" }[
		sessionStatus
	];
	const projectRef = {
		get current() {
			return session.getSnapshot().project;
		},
	};
	const saveNow = () => session.flush();
	const setConflictSnapshot = (snapshot?: ProjectSnapshot) =>
		snapshot ? session.conflict(snapshot) : session.dismissConflict();
	const setCurrentProject = (snapshot: ProjectSnapshot) => session.accept(snapshot);
	const openSession = (snapshot: ProjectSnapshot) => {
		session.open(snapshot);
		setBusy(undefined);
		setReport(snapshot.lastReport);
		setRelease(releases.find((item) => item.id === snapshot.latestReleaseId));
		localStorage.setItem(currentProjectKey, snapshot.id);
	};
	useEffect(() => () => selection.current?.abort(), []);

	const checkApiConnection = useCallback(async (signal?: AbortSignal): Promise<void> => {
		try {
			const health = await requestJson<{
				sandbox: SandboxStatus;
				capabilities: { aiChat: boolean };
			}>(apiUrl(apiOrigin, "/health"), { signal });
			if (signal?.aborted) return;
			setSandbox(health.sandbox);
			setAiConfigured(health.capabilities.aiChat);
		} catch (error) {
			if (signal?.aborted) return;
			setAiConfigured(false);
			setSandbox({
				available: false,
				image: "",
				message: error instanceof Error ? error.message : "本地制题 API 连接失败。",
			});
		}
	}, []);

	const refreshRecords = useCallback(async (): Promise<void> => {
		setRecordsLoading(true);
		try {
			const [projectList, releaseList] = await Promise.all([
				requestJson<{ projects: ProjectSnapshot[] }>(apiUrl(apiOrigin, "/projects")),
				requestJson<{ releases: ManualRelease[] }>(apiUrl(apiOrigin, "/releases")),
			]);
			setProjects(projectList.projects);
			setReleases(releaseList.releases);
			setRecordsMessage("");
		} catch (error) {
			setRecordsMessage(error instanceof Error ? error.message : "记录读取失败。");
			setRecordsTone("failed");
		} finally {
			setRecordsLoading(false);
		}
	}, []);

	useEffect(() => {
		const updatePage = (): void => setPage(pageFromHash(window.location.hash));
		window.addEventListener("hashchange", updatePage);
		return () => window.removeEventListener("hashchange", updatePage);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void checkApiConnection(controller.signal);
		void (async () => {
			try {
				const list = await requestJson<{ projects: ProjectSnapshot[] }>(apiUrl(apiOrigin, "/projects"), {
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setProjects(list.projects);
			} catch (error) {
				if (!controller.signal.aborted)
					showNotice(error instanceof Error ? error.message : "草稿读取失败。", "failed");
			}
		})();
		return () => controller.abort();
	}, [checkApiConnection, showNotice]);

	useEffect(() => {
		if (page === "records") void refreshRecords();
	}, [page, refreshRecords]);
	function editProject(change: (current: ProjectSnapshot) => ProjectSnapshot): void {
		session.edit(change);
		setReport(undefined);
		showNotice("草稿已修改，发布前需要重新验证。");
	}

	async function newProject(scoringMode: "acm" | "oi"): Promise<void> {
		selection.current?.abort();
		const controller = new AbortController();
		selection.current = controller;
		try {
			await saveNow();
			controller.signal.throwIfAborted();
			const created = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, "/projects"), {
				method: "POST",
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ scoringMode }),
			});
			controller.signal.throwIfAborted();
			await saveNow();
			controller.signal.throwIfAborted();
			openSession(created);
			setChoosingScoringMode(false);

			showNotice("已创建空白草稿；旧项目保留在制题记录中。", "passed");
			window.location.hash = "workspace";
		} catch (error) {
			if (controller.signal.aborted) return;
			showNotice(error instanceof Error ? error.message : "创建草稿失败。", "failed");
		}
	}

	async function openProject(id: string): Promise<void> {
		selection.current?.abort();
		const controller = new AbortController();
		selection.current = controller;
		try {
			await saveNow();
			controller.signal.throwIfAborted();
			const selected = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${id}`), {
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			await saveNow();
			controller.signal.throwIfAborted();
			const latest = projectRef.current;
			openSession(latest?.id === id && latest.revision > selected.revision ? latest : selected);

			showNotice(uiMessage("已打开“{0}”。", selected.title || uiMessage("未命名题目")), "passed");
			window.location.hash = "workspace";
		} catch (error) {
			if (controller.signal.aborted) return;
			setRecordsMessage(error instanceof Error ? error.message : "项目读取失败。");
			setRecordsTone("failed");
		}
	}

	async function deleteProject(id: string): Promise<void> {
		try {
			const response = await fetch(apiUrl(apiOrigin, `/projects/${id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			if (projectRef.current?.id === id) {
				session.open();
				setReport(undefined);
				setRelease(undefined);
				localStorage.removeItem(currentProjectKey);
			}
			await refreshRecords();
			setRecordsMessage("项目及其发布包已删除。");
			setRecordsTone("passed");
		} catch (error) {
			setRecordsMessage(error instanceof Error ? error.message : "删除失败。");
			setRecordsTone("failed");
		}
	}

	async function deleteRelease(id: string): Promise<void> {
		try {
			const response = await fetch(apiUrl(apiOrigin, `/releases/${id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			if (release?.id === id) setRelease(undefined);
			await refreshRecords();
			setRecordsMessage("发布包已删除；草稿仍保留。");
			setRecordsTone("passed");
		} catch (error) {
			setRecordsMessage(error instanceof Error ? error.message : "删除发布包失败。");
			setRecordsTone("failed");
		}
	}

	async function uploadFiles(files: File[]): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		setBusy("upload");
		try {
			await saveNow();
			signal.throwIfAborted();
			let snapshot = projectRef.current ?? current;
			for (const file of files) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(in|out|ans)$/u.test(file.name))
					throw new Error(`不支持的测试文件名：${file.name}`);
				snapshot = await requestJson<ProjectSnapshot>(
					apiUrl(apiOrigin, `/projects/${current.id}/files/${encodeURIComponent(file.name)}`),
					{
						method: "PUT",
						signal,
						headers: {
							"content-type": "application/octet-stream",
							"x-expected-revision": String(snapshot.revision),
						},
						body: file,
					},
				);
				signal.throwIfAborted();
				setCurrentProject(snapshot);
			}
			setReport(undefined);
			showNotice(uiMessage("已上传 {0} 个测试文件。", files.length), "passed");
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof RevisionConflict) setConflictSnapshot(error.current);
			showNotice(error instanceof Error ? error.message : "测试文件上传失败。", "failed");
		} finally {
			if (!signal.aborted) setBusy(undefined);
		}
	}

	async function addTextCase(value: {
		name?: string;
		input: string;
		output?: string;
		subtaskId: number;
	}): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) throw new Error("请先创建题目草稿。");
		setBusy("upload");
		try {
			await saveNow();
			signal.throwIfAborted();
			const revision = projectRef.current?.revision ?? current.revision;
			const result = await requestJson<{
				inputFile: string;
				outputFile?: string;
				project: ProjectSnapshot;
			}>(apiUrl(apiOrigin, `/projects/${current.id}/cases`), {
				method: "POST",
				signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...value, expectedRevision: revision }),
			});
			signal.throwIfAborted();
			setCurrentProject(result.project);
			setReport(undefined);
			showNotice(
				uiMessage(
					"已添加 {0}{1}。{2}",
					result.inputFile,
					result.outputFile ? uiMessage(" 与 {0}", result.outputFile) : uiMessage("，输出将在验证时由标程生成"),
					current.cases.some((item) => item.origin === "generated")
						? uiMessage("已有 Gen 数据，请重跑 Gen 后再打包。")
						: "",
				),
				"passed",
			);
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof RevisionConflict) setConflictSnapshot(error.current);
			showNotice(error instanceof Error ? error.message : "添加测试点失败。", "failed");
			throw error;
		} finally {
			if (!signal.aborted) setBusy(undefined);
		}
	}

	async function manageCases(
		action: "batch-delete" | "renumber" | "clear-generated",
		stems?: string[],
	): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		await saveNow();
		signal.throwIfAborted();
		const target = projectRef.current ?? current;
		const path =
			action === "clear-generated" ? `/projects/${target.id}/generated` : `/projects/${target.id}/cases/${action}`;
		const snapshot = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, path), {
			method: action === "clear-generated" ? "DELETE" : "POST",
			signal,
			headers: { "content-type": "application/json", "x-expected-revision": String(target.revision) },
			...(action !== "clear-generated"
				? { body: JSON.stringify({ stems, expectedRevision: target.revision }) }
				: {}),
		});
		signal.throwIfAborted();
		setCurrentProject(snapshot);
		setReport(undefined);
		showNotice(
			action === "batch-delete"
				? "所选测试点已删除。"
				: action === "renumber"
					? "手动数字测试点已重新编号。"
					: "Gen 数据已移除。",
			"passed",
		);
	}

	async function uploadAttachments(files: File[]): Promise<void> {
		const signal = session.signal;
		try {
			const additions: ProjectSnapshot["attachments"] = [];
			for (const file of files) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file.name) || file.size > 1024 * 1024)
					throw new Error(`附件 ${file.name} 文件名不合法或超过 1 MiB。`);
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				additions.push({ name: file.name, contentBase64: btoa(binary) });
			}
			signal.throwIfAborted();
			editProject((current) => ({
				...current,
				attachments: [
					...current.attachments.filter((item) => !additions.some((other) => other.name === item.name)),
					...additions,
				],
			}));
		} catch (error) {
			if (signal.aborted) return;
			showNotice(error instanceof Error ? error.message : "附件读取失败。", "failed");
		}
	}

	async function uploadDomjudgePdf(file: File): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		setBusy("upload");
		try {
			await saveNow();
			signal.throwIfAborted();
			const revision = projectRef.current?.revision ?? current.revision;
			const snapshot = await requestJson<ProjectSnapshot>(
				apiUrl(apiOrigin, `/projects/${current.id}/domjudge-pdf`),
				{
					method: "PUT",
					signal,
					headers: { "content-type": "application/pdf", "x-expected-revision": String(revision) },
					body: file,
				},
			);
			signal.throwIfAborted();
			setCurrentProject(snapshot);
			setReport(undefined);
			showNotice("DOMjudge PDF 已上传；重新验证后会进入新发布包。", "passed");
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof RevisionConflict) setConflictSnapshot(error.current);
			showNotice(error instanceof Error ? error.message : "PDF 上传失败。", "failed");
		} finally {
			if (!signal.aborted) setBusy(undefined);
		}
	}

	async function deleteDomjudgePdf(): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		try {
			await saveNow();
			signal.throwIfAborted();
			const revision = projectRef.current?.revision ?? current.revision;
			const snapshot = await requestJson<ProjectSnapshot>(
				apiUrl(apiOrigin, `/projects/${current.id}/domjudge-pdf`),
				{
					method: "DELETE",
					signal,
					headers: { "x-expected-revision": String(revision) },
				},
			);
			signal.throwIfAborted();
			setCurrentProject(snapshot);
			setReport(undefined);
			showNotice("已移除 DOMjudge PDF；重新验证后生效。", "passed");
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof RevisionConflict) setConflictSnapshot(error.current);
			showNotice(error instanceof Error ? error.message : "移除 PDF 失败。", "failed");
		}
	}

	async function deleteFile(name: string): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		try {
			await saveNow();
			signal.throwIfAborted();
			const revision = projectRef.current?.revision ?? current.revision;
			const snapshot = await requestJson<ProjectSnapshot>(
				apiUrl(apiOrigin, `/projects/${current.id}/files/${encodeURIComponent(name)}`),
				{ method: "DELETE", signal, headers: { "x-expected-revision": String(revision) } },
			);
			signal.throwIfAborted();
			setCurrentProject(snapshot);
			setReport(undefined);
			showNotice(uiMessage("已删除 {0}。", name), "passed");
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof RevisionConflict) setConflictSnapshot(error.current);
			showNotice(error instanceof Error ? error.message : "删除文件失败。", "failed");
		}
	}

	async function generate(): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		setBusy("generate");
		showNotice("正在编译 Gen 和标程，逐条生成并复现检查…");
		try {
			await saveNow();
			signal.throwIfAborted();
			const accepted = await requestJson<{ task: BackgroundTask }>(
				apiUrl(apiOrigin, `/projects/${current.id}/generate`),
				{ method: "POST", signal },
			);
			signal.throwIfAborted();
			setActiveTask(accepted.task);
			const result = await waitForTask<{ project: ProjectSnapshot; report: ManualReport }>(
				apiOrigin,
				accepted.task.id,
				(task) => {
					if (!signal.aborted) setActiveTask(task);
				},
				signal,
			);
			signal.throwIfAborted();
			setCurrentProject(result.project);
			if (projectRef.current?.id !== current.id) return;
			setReport(result.report);
			showNotice(
				result.report.success
					? uiMessage(
							"生成 {0} 个测试点，标准程序{1}通过。",
							result.report.generatedCount,
							result.report.oracleCount ? uiMessage("与第二标准程序交叉核验") : uiMessage("运行"),
						)
					: uiMessage("Gen 或数据检查失败，上一批生成点已保留。请查看验证报告。"),
				result.report.success ? "passed" : "failed",
			);
		} catch (error) {
			if (signal.aborted) return;
			showNotice(error instanceof Error ? error.message : "生成失败。", "failed");
		} finally {
			if (!signal.aborted) setBusy(undefined);
		}
	}

	async function finalize(): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		setBusy("finalize");
		showNotice("正在完整验证测试数据与程序，并生成 Hydro 包…");
		try {
			await saveNow();
			signal.throwIfAborted();
			const accepted = await requestJson<{ task: BackgroundTask }>(
				apiUrl(apiOrigin, `/projects/${current.id}/finalize`),
				{ method: "POST", signal },
			);
			signal.throwIfAborted();
			setActiveTask(accepted.task);
			const result = await waitForTask<{ release?: ManualRelease; report: ManualReport }>(
				apiOrigin,
				accepted.task.id,
				(task) => {
					if (!signal.aborted) setActiveTask(task);
				},
				signal,
			);
			signal.throwIfAborted();
			if (projectRef.current?.id !== current.id) return;
			setReport(result.report);
			if (result.release) setRelease(result.release);
			const refreshed = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${current.id}`), { signal });
			signal.throwIfAborted();
			setCurrentProject(refreshed);
			showNotice(
				result.release
					? "本地完整验证与 Hydro 目录检查通过，两个包均可下载。"
					: "完整验证未通过，未生成新的下载包。请查看失败项。",
				result.release ? "passed" : "failed",
			);
		} catch (error) {
			if (signal.aborted) return;
			showNotice(error instanceof Error ? error.message : "验证或打包失败。", "failed");
		} finally {
			if (!signal.aborted) setBusy(undefined);
		}
	}

	return (
		<>
			<header className="site-header">
				<div className="header-inner">
					<a className="brand" href="#workspace" aria-label={t("Hydro Problem Make 首页")}>
						<span className="brand-mark" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<span className="brand-wordmark">
							Hydro<span>PROBLEM MAKE</span>
						</span>
					</a>
					<nav className="main-nav" aria-label={t("主导航")}>
						<a className={page === "workspace" ? "active" : ""} href="#workspace">
							{t("制题工作台")}
						</a>
						<a className={page === "chat" ? "active" : ""} href="#chat">
							{t("AI 对话")}
						</a>
						<a className={page === "records" ? "active" : ""} href="#records">
							{t("制题记录")}
						</a>
						<a className={page === "contests" ? "active" : ""} href="#contests">
							{t("竞赛")}
						</a>
						<a className={page === "tasks" ? "active" : ""} href="#tasks">
							{t("任务")}
							{activeTask && ["queued", "running"].includes(activeTask.state) ? t(" · 进行中") : ""}
						</a>
						<a className={page === "settings" ? "active" : ""} href="#settings">
							{t("设置")}
						</a>
					</nav>
					<div className="header-tools">
						<LocaleSwitcher />
					</div>
				</div>
			</header>
			<Suspense fallback={<main className="page page-loading">{t("正在打开页面…")}</main>}>
				{page === "workspace" &&
					(project ? (
						<ManualWorkspace
							key={project.id}
							apiOrigin={apiOrigin}
							project={project}
							release={release}
							report={report}
							sandbox={sandbox}
							busy={busy}
							saveStatus={saveStatus}
							notice={notice}
							noticeTone={noticeTone}
							onEdit={editProject}
							onUpload={uploadFiles}
							onAddCase={addTextCase}
							onManageCases={manageCases}
							onUploadAttachments={uploadAttachments}
							onUploadDomjudgePdf={uploadDomjudgePdf}
							onDeleteDomjudgePdf={deleteDomjudgePdf}
							onDeleteFile={deleteFile}
							onGenerate={generate}
							onFinalize={finalize}
							onNew={async () => setChoosingScoringMode(true)}
						/>
					) : (
						<WorkspaceHome
							projects={projects}
							sandbox={sandbox}
							onNew={() => setChoosingScoringMode(true)}
							onOpen={openProject}
						/>
					))}
				{page === "chat" && (
					<AiChatPage
						apiOrigin={apiOrigin}
						configured={aiConfigured}
						projectSnapshot={project ? projectContextSnapshot(project) : undefined}
					/>
				)}
				{page === "records" && (
					<RecordsPage
						apiOrigin={apiOrigin}
						projects={projects}
						releases={releases}
						loading={recordsLoading}
						message={recordsMessage}
						tone={recordsTone}
						onRefresh={refreshRecords}
						onOpen={openProject}
						onDelete={deleteProject}
						onDeleteRelease={deleteRelease}
					/>
				)}
				{page === "contests" && <ContestsPage apiOrigin={apiOrigin} />}
				{page === "tasks" && <TasksPage apiOrigin={apiOrigin} />}
				{page === "settings" && (
					<SettingsPage
						apiOrigin={apiOrigin}
						sandbox={sandbox}
						onRefreshSandbox={() => void checkApiConnection()}
						onAiConfigurationChanged={() => void checkApiConnection()}
					/>
				)}
			</Suspense>
			{choosingScoringMode && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="scoring-mode-title"
					>
						<div className="confirmation-heading">
							<span>{t("新建题目")}</span>
							<h2 id="scoring-mode-title">{t("选择赛制")}</h2>
						</div>
						<p>{t("选择适合这道题的计分方式。创建后赛制固定。")}</p>
						<div className="scoring-options">
							<button type="button" onClick={() => void newProject("acm")}>
								<span className="scoring-symbol">ACM</span>
								<span className="scoring-copy">
									<strong>{t("全部通过")}</strong>
									<small className="scoring-description">
										{t("所有测试点通过即得分。支持 Hydro 与 DOMjudge。")}
									</small>
								</span>
								<Icon name="arrow" />
							</button>
							<button type="button" onClick={() => void newProject("oi")}>
								<span className="scoring-symbol">OI</span>
								<span className="scoring-copy">
									<strong>{t("子任务计分")}</strong>
									<small className="scoring-description">{t("按子任务分配分值。支持 Hydro。")}</small>
								</span>
								<Icon name="arrow" />
							</button>
						</div>
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setChoosingScoringMode(false)}>
								{t("取消")}
							</button>
						</div>
					</div>
				</div>
			)}
			{conflictSnapshot && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="conflict-title"
					>
						<div className="confirmation-heading">
							<span>{t("版本冲突")}</span>
							<h2 id="conflict-title">{t("草稿已在其他窗口更新")}</h2>
						</div>
						<p>
							{t(
								"服务器版本为 {0}。加载前可复制当前编辑内容；加载会替换当前窗口未保存的修改。",
								conflictSnapshot.revision,
							)}
						</p>
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setConflictSnapshot(undefined)}>
								{t("保留当前内容")}
							</button>
							<button
								className="button primary"
								type="button"
								onClick={() => {
									openSession(conflictSnapshot);
									setConflictSnapshot(undefined);
								}}
							>
								{t("加载服务器版本")}
							</button>
						</div>
					</div>
				</div>
			)}
			<footer className="site-footer">
				<span className="footer-name">Hydro Problem Make</span>
				<span className="footer-tagline">{t("专注出题，自在创作。")}</span>
				<span className="footer-detail">LOCAL WORKSPACE</span>
			</footer>
		</>
	);
}
