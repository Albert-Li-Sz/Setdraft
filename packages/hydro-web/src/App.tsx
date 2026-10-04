import type { AuthUser, ProblemType } from "@setdraft/contracts";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { AppShell } from "./AppShell.tsx";
import { RevisionConflict, requestJson } from "./api-client.ts";
import { authClient, authFetch } from "./auth-client.ts";
import { CopyProblemDialog } from "./CopyProblemDialog.tsx";
import { Dialog } from "./Dialog.tsx";
import { DraftCompareDialog } from "./DraftDialogs.tsx";
import "./authoring-insights.css";
import type { DraftRecovery } from "./draft-recovery.ts";
import { readFileWithProgress, transferFiles, transfers } from "./file-transfer.ts";
import { type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
import { LoadingState } from "./LoadingState.tsx";
import { ProblemTypeSelect } from "./ProblemTypeSelect.tsx";
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
import { addProjectTextCase, type CaseOperationScope, manageProjectCases } from "./project-case-operations.ts";
import { UploadProgressDialog } from "./UploadProgressDialog.tsx";
import { useProjectSession } from "./use-project-session.ts";
import { WorkspaceHome } from "./WorkspaceHome.tsx";

import { readWorkspaceLocation, useLocationHash, workspaceHash } from "./workspace-navigation.ts";

const AiChatPage = lazy(() => import("./AiChatPage.tsx").then((module) => ({ default: module.AiChatPage })));
const ContestsPage = lazy(() => import("./ContestsPage.tsx").then((module) => ({ default: module.ContestsPage })));
const ManualWorkspace = lazy(() =>
	import("./ManualWorkspace.tsx").then((module) => ({ default: module.ManualWorkspace })),
);
const RecordsPage = lazy(() => import("./RecordsPage.tsx").then((module) => ({ default: module.RecordsPage })));
const SettingsPage = lazy(() => import("./SettingsPage.tsx").then((module) => ({ default: module.SettingsPage })));
const AdminSettingsPage = lazy(() =>
	import("./AdminSettingsPage.tsx").then((module) => ({ default: module.AdminSettingsPage })),
);
const TasksPage = lazy(() => import("./TasksPage.tsx").then((module) => ({ default: module.TasksPage })));
const AuthoringGuide = lazy(() =>
	import("./AuthoringGuide.tsx").then((module) => ({ default: module.AuthoringGuide })),
);

export function App({ user, paused }: { user: AuthUser; paused: boolean }) {
	const currentProjectKey = `setdraft.project-id.${user.id}`;
	const { t } = useLocale();
	const [page, setPage] = useState<PageRoute>(() => pageFromHash(window.location.hash));
	const locationHash = useLocationHash();
	const linkedProject = readWorkspaceLocation(locationHash).project;
	const [chatVisited, setChatVisited] = useState(page === "chat");
	useEffect(() => {
		if (page === "chat") setChatVisited(true);
	}, [page]);
	const apiOrigin = "";
	const selection = useRef<AbortController | undefined>(undefined);
	const recordsRequest = useRef<AbortController | undefined>(undefined);
	const [sandbox, setSandbox] = useState<SandboxStatus>();
	const [aiConfigured, setAiConfigured] = useState(false);
	const [choosingScoringMode, setChoosingScoringMode] = useState(false);
	const [newScoringMode, setNewScoringMode] = useState<"acm" | "oi">("acm");
	const [newProblemType, setNewProblemType] = useState<ProblemType>("standard");
	const [creating, setCreating] = useState(false);
	const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
	const [releases, setReleases] = useState<ManualRelease[]>([]);
	const [release, setRelease] = useState<ManualRelease>();
	const [report, setReport] = useState<ManualReport>();
	const [busy, setBusy] = useState<"upload" | "generate" | "finalize" | "restore" | "copy">();
	const contentOperation = useRef(false);
	const [copyingProject, setCopyingProject] = useState<ProjectSnapshot>();
	const [deletingProjectId, setDeletingProjectId] = useState<string>();
	const [activeTask, setActiveTask] = useState<BackgroundTask>();
	const [recordsLoading, setRecordsLoading] = useState(false);
	const [recordsMessage, setRecordsMessage] = useState<UiMessage>("");
	const [recordsTone, setRecordsTone] = useState<"passed" | "failed">("passed");
	const [notice, setNotice] = useState<UiMessage>("题目自动保存在本地服务端。请添加标准程序与测试数据。");
	const [noticeTone, setNoticeTone] = useState<"pending" | "passed" | "failed">("pending");
	const [recoveryPrompt, setRecoveryPrompt] = useState<DraftRecovery>();
	const [deferredRecoveries, setDeferredRecoveries] = useState<string[]>([]);

	const showNotice = useCallback((message: UiMessage, tone: "pending" | "passed" | "failed" = "pending"): void => {
		setNotice(message);
		setNoticeTone(tone);
	}, []);

	const {
		session,
		project,
		status: sessionStatus,
		conflict: conflictSnapshot,
		recoveries,
		discardRecovery,
		recoveryError,
	} = useProjectSession(
		apiOrigin,
		(error) => showNotice(error instanceof Error ? error.message : "题目保存失败。", "failed"),
		user.id,
	);
	useEffect(() => {
		if (recoveryPrompt && !recoveries.some((entry) => entry.id === recoveryPrompt.id)) setRecoveryPrompt(undefined);
	}, [recoveries, recoveryPrompt]);
	useEffect(() => {
		if (!project || sessionStatus !== "saved" || busy || conflictSnapshot || recoveryPrompt) return;
		const candidate = recoveries.find(
			(entry) => entry.project.id === project.id && !deferredRecoveries.includes(entry.id),
		);
		if (candidate) setRecoveryPrompt(candidate);
	}, [project, sessionStatus, busy, conflictSnapshot, recoveryPrompt, recoveries, deferredRecoveries]);
	const saveStatus = { saved: "已保存", dirty: "待保存", saving: "正在保存", conflict: "版本冲突", error: "保存失败" }[
		sessionStatus
	];
	const projectRef = {
		get current() {
			return session.getSnapshot().project;
		},
	};
	const operationSignal = session.signal;
	const saveNow = () => session.flush();
	useEffect(() => {
		if (paused) {
			transfers.clear();
			session.pause();
			selection.current?.abort();
			setBusy(undefined);
			return;
		}
		const controller = new AbortController();
		const current = session.getSnapshot().project;
		const signal = session.signal;
		void (async () => {
			try {
				if (current) {
					const latest = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${current.id}`), {
						signal: controller.signal,
					});
					if (!controller.signal.aborted && !signal.aborted) {
						session.receive(latest);
						setReport(session.getSnapshot().status === "saved" ? latest.lastReport : undefined);
					}
				}
			} catch (error) {
				if (!controller.signal.aborted)
					showNotice(error instanceof Error ? error.message : "题目读取失败。", "failed");
			} finally {
				if (!controller.signal.aborted && !signal.aborted) session.resume();
			}
		})();
		return () => controller.abort();
	}, [paused, session, showNotice]);
	const logout = async () => {
		await saveNow();
		await authClient.logout();
	};
	const setConflictSnapshot = (snapshot?: ProjectSnapshot) =>
		snapshot ? session.conflict(snapshot) : session.dismissConflict();
	const setCurrentProject = (snapshot: ProjectSnapshot) => session.receive(snapshot);
	const openSession = (snapshot: ProjectSnapshot) => {
		const previous = projectRef.current;
		setProjects((current) => [
			snapshot,
			...(previous && previous.id !== snapshot.id ? [previous] : []),
			...current.filter((item) => item.id !== snapshot.id && item.id !== previous?.id),
		]);
		session.open(snapshot);
		setBusy(undefined);
		setReport(snapshot.lastReport);
		setRelease(releases.find((item) => item.id === snapshot.latestReleaseId));
		localStorage.setItem(currentProjectKey, snapshot.id);
	};
	useEffect(
		() => () => {
			selection.current?.abort();
			recordsRequest.current?.abort();
			transfers.clear();
		},
		[],
	);

	const checkApiConnection = useCallback(async (signal?: AbortSignal): Promise<void> => {
		try {
			const health = await requestJson<{
				sandbox: SandboxStatus;
				capabilities: { aiChat: boolean };
			}>(apiUrl(apiOrigin, "/system/status"), { signal });
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

	const refreshRecords = useCallback(async (externalSignal?: AbortSignal): Promise<void> => {
		recordsRequest.current?.abort();
		const controller = new AbortController();
		recordsRequest.current = controller;
		const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
		setRecordsLoading(true);
		try {
			const [projectList, releaseList] = await Promise.all([
				requestJson<{ projects: ProjectSnapshot[] }>(apiUrl(apiOrigin, "/projects"), { signal }),
				requestJson<{ releases: ManualRelease[] }>(apiUrl(apiOrigin, "/releases"), { signal }),
			]);
			if (signal.aborted) return;
			setProjects(projectList.projects);
			setReleases(releaseList.releases);
			setRecordsMessage("");
		} catch (error) {
			if (signal.aborted) return;
			setRecordsMessage(error instanceof Error ? error.message : "记录读取失败。");
			setRecordsTone("failed");
		} finally {
			if (recordsRequest.current === controller) setRecordsLoading(false);
		}
	}, []);

	useEffect(() => {
		const updatePage = (): void => {
			setPage(pageFromHash(window.location.hash));
		};
		window.addEventListener("hashchange", updatePage);
		return () => window.removeEventListener("hashchange", updatePage);
	}, []);

	useEffect(() => {
		if (paused) {
			recordsRequest.current?.abort();
			setRecordsLoading(false);
			return;
		}
		const controller = new AbortController();
		void checkApiConnection(controller.signal);
		void refreshRecords(controller.signal);
		return () => controller.abort();
	}, [checkApiConnection, refreshRecords, paused]);

	useEffect(() => {
		if (!paused && page === "records") void refreshRecords();
	}, [page, refreshRecords, paused]);
	function editProject(change: (current: ProjectSnapshot) => ProjectSnapshot): void {
		if (contentOperation.current) return;
		session.edit(change);
		setReport(undefined);
		showNotice("题目已修改，发布前需要重新验证。");
	}

	async function newProject(scoringMode: "acm" | "oi", problemType: ProblemType): Promise<void> {
		if (contentOperation.current || creating) return;
		setCreating(true);
		selection.current?.abort();
		const controller = new AbortController();
		selection.current = controller;
		try {
			await saveNow();
			controller.signal.throwIfAborted();
			const created = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, "/projects"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ scoringMode, problemType }),
			});
			recordsRequest.current?.abort();
			setProjects((items) => [created, ...items.filter((item) => item.id !== created.id)]);
			controller.signal.throwIfAborted();
			await saveNow();
			controller.signal.throwIfAborted();
			openSession(created);
			setChoosingScoringMode(false);

			showNotice("题目已创建，所有题目都保存在题目中心。", "passed");
			window.location.hash = workspaceHash({ project: created.id });
		} catch (error) {
			if (controller.signal.aborted) return;
			showNotice(error instanceof Error ? error.message : "创建题目失败。", "failed");
		} finally {
			setCreating(false);
		}
	}

	async function openProject(id: string, preserveRoute = false): Promise<void> {
		if (contentOperation.current) return;
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
			const history = await requestJson<{ releases: ManualRelease[] }>(
				apiUrl(apiOrigin, `/projects/${id}/releases`),
				{ signal: controller.signal },
			);
			controller.signal.throwIfAborted();
			setRelease(history.releases.find((item) => item.id === selected.latestReleaseId));

			showNotice(uiMessage("已打开“{0}”。", selected.title || uiMessage("未命名题目")), "passed");
			if (!preserveRoute) window.location.hash = workspaceHash({ project: id });
		} catch (error) {
			if (controller.signal.aborted) return;
			setRecordsMessage(error instanceof Error ? error.message : "项目读取失败。");
			setRecordsTone("failed");
		}
	}

	const openLinkedProject = useEffectEvent((id: string) => {
		if (session.getSnapshot().project?.id !== id) void openProject(id, true);
	});
	useEffect(() => {
		if (paused || !linkedProject) return;
		openLinkedProject(linkedProject);
		return () => selection.current?.abort();
	}, [linkedProject, paused]);

	async function deleteProject(id: string): Promise<void> {
		setDeletingProjectId(id);
		recordsRequest.current?.abort();
		try {
			if (projectRef.current?.id === id) await saveNow();
			const response = await authFetch(apiUrl(apiOrigin, `/projects/${id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			if (projectRef.current?.id === id) {
				session.open();
				setReport(undefined);
				setRelease(undefined);
				localStorage.removeItem(currentProjectKey);
			}
			setProjects((current) => current.filter((item) => item.id !== id));
			setReleases((current) => current.filter((item) => item.projectId !== id));
			await refreshRecords();
			setRecordsMessage("项目及其发布包已删除。");
			setRecordsTone("passed");
		} catch (error) {
			const message = error instanceof Error ? error.message : "删除失败。";
			setRecordsMessage(message);
			setRecordsTone("failed");
			showNotice(message, "failed");
		} finally {
			setDeletingProjectId(undefined);
		}
	}

	async function restoreRelease(selected: ManualRelease): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current || current.id !== selected.projectId || contentOperation.current)
			throw new Error("请重新打开题目后重试。");
		contentOperation.current = true;
		setBusy("restore");
		try {
			await saveNow();
			signal.throwIfAborted();
			const restored = await requestJson<ProjectSnapshot>(
				apiUrl(apiOrigin, `/projects/${current.id}/releases/${selected.id}/restore`),
				{
					method: "POST",
					signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ expectedRevision: projectRef.current?.revision }),
				},
			);
			signal.throwIfAborted();
			openSession(restored);
			showNotice(uiMessage("已回退到“{0}”。发布前请重新验证。", selected.name || `v${selected.revision}`), "passed");
		} finally {
			contentOperation.current = false;
			setBusy(undefined);
		}
	}
	async function restoreDraft(revision: number): Promise<void> {
		const current = projectRef.current,
			signal = session.signal;
		if (!current || contentOperation.current) throw new Error("请重新打开题目后重试。");
		contentOperation.current = true;
		setBusy("restore");
		try {
			await saveNow();
			signal.throwIfAborted();
			const restored = await requestJson<ProjectSnapshot>(
				apiUrl(apiOrigin, `/projects/${current.id}/drafts/${revision}/restore`),
				{
					method: "POST",
					signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ expectedRevision: projectRef.current?.revision }),
				},
			);
			signal.throwIfAborted();
			openSession(restored);
			showNotice("草稿已恢复到新版本，请重新验证。", "passed");
		} catch (error) {
			if (error instanceof RevisionConflict) session.conflict(error.current);
			throw error;
		} finally {
			contentOperation.current = false;
			setBusy(undefined);
		}
	}

	async function copyToUser(recipientId: string): Promise<void> {
		if (!copyingProject || contentOperation.current) throw new Error("请重新打开题目后重试。");
		contentOperation.current = true;
		setBusy("copy");
		const signal = session.signal;
		try {
			if (projectRef.current?.id === copyingProject.id) await saveNow();
			signal.throwIfAborted();
			const current = projectRef.current?.id === copyingProject.id ? projectRef.current : copyingProject;
			await requestJson(apiUrl(apiOrigin, `/projects/${copyingProject.id}/copy`), {
				method: "POST",
				signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ recipientId, expectedRevision: current.revision }),
			});
			signal.throwIfAborted();
		} finally {
			contentOperation.current = false;
			setBusy(undefined);
		}
	}

	async function releaseChanged(): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		await refreshRecords();
		if (!current || signal.aborted) return;
		try {
			const [snapshot, history] = await Promise.all([
				requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${current.id}`), { signal }),
				requestJson<{ releases: ManualRelease[] }>(apiUrl(apiOrigin, `/projects/${current.id}/releases`), {
					signal,
				}),
			]);
			signal.throwIfAborted();
			setCurrentProject(snapshot);
			setRelease(history.releases.find((item) => item.id === snapshot.latestReleaseId));
		} catch (error) {
			if (!signal.aborted) showNotice(error instanceof Error ? error.message : "发布包读取失败。", "failed");
		}
	}

	async function uploadFiles(files: File[]): Promise<void> {
		const current = projectRef.current;
		const signal = session.signal;
		if (!current) return;
		setBusy("upload");
		try {
			await transferFiles(files.map((file) => file.name).join(", "), async (progress) => {
				await saveNow();
				signal.throwIfAborted();
				let snapshot = projectRef.current ?? current;
				const total = files.reduce((sum, file) => sum + file.size, 0);
				let uploaded = 0;
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
							onUploadProgress: (loaded) =>
								progress({ phase: "uploading", file: file.name, loaded: uploaded + loaded, total }),
						},
					);
					signal.throwIfAborted();
					setCurrentProject(snapshot);
					uploaded += file.size;
				}
				setReport(undefined);
				showNotice(uiMessage("已上传 {0} 个测试文件。", files.length), "passed");
			});
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
		if (!current) throw new Error("请先创建题目。");
		setBusy("upload");
		try {
			const result = await addProjectTextCase(session, apiOrigin, value);
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
			signal.throwIfAborted();
			if (error instanceof RevisionConflict) setConflictSnapshot(error.current);
			showNotice(error instanceof Error ? error.message : "添加测试点失败。", "failed");
			throw error;
		} finally {
			if (!signal.aborted) setBusy(undefined);
		}
	}

	async function manageCases(
		scope: CaseOperationScope,
		action: "batch-delete" | "renumber" | "clear-generated",
		stems?: string[],
	): Promise<void> {
		const snapshot = await manageProjectCases(session, apiOrigin, scope, action, stems);
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
		setBusy("upload");
		try {
			await transferFiles(files.map((file) => file.name).join(", "), async (progress) => {
				const additions: ProjectSnapshot["attachments"] = [];
				const total = files.reduce((sum, file) => sum + file.size, 0);
				let read = 0;
				for (const file of files) {
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file.name) || file.size > 1024 * 1024)
						throw new Error(`附件 ${file.name} 文件名不合法或超过 1 MiB。`);
					const bytes = new Uint8Array(
						await readFileWithProgress(
							file,
							(loaded) => progress({ phase: "reading", file: file.name, loaded: read + loaded, total }),
							signal,
						),
					);
					let binary = "";
					for (const byte of bytes) binary += String.fromCharCode(byte);
					additions.push({ name: file.name, contentBase64: btoa(binary) });
					read += file.size;
				}
				signal.throwIfAborted();
				editProject((current) => ({
					...current,
					attachments: [
						...current.attachments.filter((item) => !additions.some((other) => other.name === item.name)),
						...additions,
					],
				}));
				progress({ phase: "saving" });
				await saveNow();
				signal.throwIfAborted();
				showNotice("附件已上传，可一键复制引用。", "passed");
			});
		} catch (error) {
			if (signal.aborted) return;
			showNotice(error instanceof Error ? error.message : "附件读取失败。", "failed");
		} finally {
			if (!signal.aborted) setBusy(undefined);
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

	async function finalize(name: string): Promise<void> {
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
				{ method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
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
			if (result.release) {
				setRelease(result.release);
				setReleases((items) => [result.release!, ...items]);
			}
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
			<AppShell
				user={user}
				onLogout={logout}
				page={page}
				projects={project ? [project, ...projects.filter((item) => item.id !== project.id)] : projects}
				currentProjectId={project?.id}
				busy={creating || !!busy || !!deletingProjectId}
				taskRunning={!!activeTask && ["queued", "running"].includes(activeTask.state)}
				onNew={() => {
					selection.current?.abort();
					setNewProblemType("standard");
					setNewScoringMode("acm");
					setChoosingScoringMode(true);
				}}
				onOpen={openProject}
			>
				{/* Keep the user-scoped chat and its stream alive across route changes. */}
				<Suspense
					fallback={
						page === "chat" ? (
							<main className="page page-loading">
								<LoadingState label={t("正在打开页面…")} />
							</main>
						) : null
					}
				>
					{(page === "chat" || chatVisited) && (
						<AiChatPage
							active={page === "chat"}
							paused={paused}
							apiOrigin={apiOrigin}
							configured={aiConfigured}
							administrator={user.role === "admin"}
							projectSnapshot={project ? projectContextSnapshot(project) : undefined}
						/>
					)}
				</Suspense>
				<Suspense
					fallback={
						<main className="page page-loading">
							<LoadingState label={t("正在打开页面…")} />
						</main>
					}
				>
					{page === "workspace" &&
						(project ? (
							<ManualWorkspace
								key={project.id}
								apiOrigin={apiOrigin}
								session={session}
								project={project}
								release={release}
								report={report}
								sandbox={sandbox}
								busy={busy}
								deleting={deletingProjectId === project.id}
								saveStatus={saveStatus}
								notice={notice}
								noticeTone={noticeTone}
								onEdit={editProject}
								onUpload={uploadFiles}
								onAddCase={addTextCase}
								signal={operationSignal}
								onManageCases={(action, stems, expectedRevision) =>
									manageCases(
										{ projectId: project.id, signal: operationSignal, expectedRevision },
										action,
										stems,
									)
								}
								onUploadAttachments={uploadAttachments}
								onDeleteFile={deleteFile}
								onGenerate={generate}
								onFinalize={finalize}
								onRestore={restoreRelease}
								onRestoreDraft={restoreDraft}
								onReleasesChanged={() => void releaseChanged()}
								onCopy={() => setCopyingProject(project)}
								onDelete={deleteProject}
							/>
						) : (
							<WorkspaceHome
								administrator={user.role === "admin"}
								projects={projects}
								loading={recordsLoading}
								busy={creating || !!busy || !!deletingProjectId}
								sandbox={sandbox}
								message={recordsMessage || undefined}
								messageTone={recordsTone}
								onNew={() => {
									selection.current?.abort();
									setNewProblemType("standard");
									setNewScoringMode("acm");
									setChoosingScoringMode(true);
								}}
								onOpen={openProject}
							/>
						))}
					{page === "records" && (
						<RecordsPage
							busy={!!busy || !!deletingProjectId}
							projects={projects}
							releases={releases}
							loading={recordsLoading}
							message={recordsMessage}
							tone={recordsTone}
							onRefresh={refreshRecords}
							onOpen={openProject}
							onDelete={deleteProject}
							onCopy={setCopyingProject}
						/>
					)}
					{page === "contests" && <ContestsPage apiOrigin={apiOrigin} paused={paused} />}
					{page === "authoring-guide" && <AuthoringGuide />}
					{page === "tasks" && <TasksPage apiOrigin={apiOrigin} paused={paused} />}
					{page === "settings" && <SettingsPage user={user} />}
					{page === "admin" && user.role === "admin" && (
						<AdminSettingsPage
							user={user}
							apiOrigin={apiOrigin}
							sandbox={sandbox}
							onRefreshSandbox={() => void checkApiConnection()}
							onAiConfigurationChanged={() => void checkApiConnection()}
						/>
					)}
					{page === "admin" && user.role !== "admin" && (
						<main className="page">
							<p>{t("仅管理员可以访问此页面。")}</p>
						</main>
					)}
				</Suspense>
			</AppShell>
			<UploadProgressDialog />
			<Dialog
				open={choosingScoringMode}
				onClose={() => {
					selection.current?.abort();
					setChoosingScoringMode(false);
				}}
				labelledBy="scoring-mode-title"
			>
				<div className="confirmation-heading">
					<span>{t("新建题目")}</span>
					<h2 id="scoring-mode-title">{t("题型与计分方式")}</h2>
				</div>
				<p>{t("选择适合这道题的计分方式。创建后赛制固定。")}</p>
				<ProblemTypeSelect value={newProblemType} disabled={creating} onChange={setNewProblemType} />
				<label className="field">
					<span>{t("计分方式")}</span>
					<select
						aria-label={t("计分方式")}
						value={newScoringMode}
						disabled={creating}
						onChange={(event) => setNewScoringMode(event.target.value as "acm" | "oi")}
					>
						<option value="acm">ACM · {t("全部通过")}</option>
						<option value="oi">OI · {t("子任务计分")}</option>
					</select>
				</label>
				<div className="confirmation-actions">
					<button
						className="button secondary"
						type="button"
						onClick={() => {
							selection.current?.abort();
							setChoosingScoringMode(false);
						}}
					>
						{t("取消")}
					</button>
					<button
						className="button primary"
						type="button"
						disabled={creating}
						onClick={() => void newProject(newScoringMode, newProblemType)}
					>
						{t(creating ? "创建中…" : "创建题目")}
					</button>
				</div>
			</Dialog>
			{copyingProject && (
				<CopyProblemDialog
					key={copyingProject.id}
					apiOrigin={apiOrigin}
					title={copyingProject.title}
					onClose={() => setCopyingProject(undefined)}
					onCopy={copyToUser}
				/>
			)}
			{recoveryError && (
				<output className="notice failed" role="alert">
					{t(recoveryError)}
				</output>
			)}
			{project && sessionStatus === "conflict" && !conflictSnapshot && (
				<button
					type="button"
					className="button secondary draft-recovery-banner"
					onClick={() => {
						const remote = session.getConflict();
						if (remote) session.conflict(remote);
					}}
				>
					{t("比较版本冲突")}
				</button>
			)}
			{project && !recoveryPrompt && recoveries.some((entry) => entry.project.id === project.id) && (
				<button
					type="button"
					className="button secondary draft-recovery-banner"
					onClick={() => setRecoveryPrompt(recoveries.find((entry) => entry.project.id === project.id))}
				>
					{t("恢复未保存内容")}
				</button>
			)}
			{conflictSnapshot && project && session.getBaseline() && (
				<DraftCompareDialog
					key={`conflict:${project.id}:${conflictSnapshot.revision}`}
					base={session.getBaseline()!}
					local={project}
					server={conflictSnapshot}
					onClose={() => setConflictSnapshot(undefined)}
					onServer={() => {
						openSession(conflictSnapshot);
						setConflictSnapshot(undefined);
					}}
					onApply={async (choices) => {
						session.resolveConflict(choices);
						await session.flush();
						setReport(undefined);
						showNotice("冲突已合并并保存，请重新验证。", "passed");
					}}
				/>
			)}
			{recoveryPrompt && project?.id === recoveryPrompt.project.id && !conflictSnapshot && (
				<DraftCompareDialog
					key={recoveryPrompt.id}
					base={recoveryPrompt.base}
					local={recoveryPrompt.project}
					server={project}
					recovery={recoveryPrompt}
					onClose={() => {
						setDeferredRecoveries((entries) => [...entries, recoveryPrompt.id]);
						setRecoveryPrompt(undefined);
					}}
					onServer={() => {
						discardRecovery(recoveryPrompt.id);
						setRecoveryPrompt(undefined);
					}}
					onApply={async (choices) => {
						const entry = recoveryPrompt;
						session.recover(entry.base, entry.project, project, choices);
						await session.flush();
						discardRecovery(entry.id);
						setRecoveryPrompt(undefined);
						setReport(undefined);
						showNotice("未保存内容已恢复并保存。", "passed");
					}}
				/>
			)}
		</>
	);
}
