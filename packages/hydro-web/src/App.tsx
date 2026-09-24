import { useCallback, useEffect, useRef, useState } from "react";
import { AiChatPage } from "./AiChatPage.tsx";
import { ManualWorkspace } from "./ManualWorkspace.tsx";
import {
	type ApiStatus,
	apiStatusLabel,
	apiUrl,
	type ManualRelease,
	type ManualReport,
	normalizeApiOrigin,
	type PageRoute,
	type ProjectSnapshot,
	pageFromHash,
	responseError,
	type SandboxStatus,
} from "./platform.ts";
import { editableProject, projectContextSnapshot } from "./problem.ts";
import { RecordsPage } from "./RecordsPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

const originKey = "hydro-problem-make.api-origin";
const currentProjectKey = "hydro-problem-make.project-id";

function storedApiOrigin(): string {
	try {
		return normalizeApiOrigin(localStorage.getItem(originKey) ?? "");
	} catch {
		localStorage.removeItem(originKey);
		return "";
	}
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = (await response.json()) as unknown;
	if (!response.ok) throw new Error(responseError(body));
	return body as T;
}

export function App() {
	const [page, setPage] = useState<PageRoute>(() => pageFromHash(window.location.hash));
	const [apiOrigin, setApiOrigin] = useState(storedApiOrigin);
	const [apiOriginDraft, setApiOriginDraft] = useState(apiOrigin);
	const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
	const [sandbox, setSandbox] = useState<SandboxStatus>();
	const [aiConfigured, setAiConfigured] = useState(false);
	const [liveHydroConfigured, setLiveHydroConfigured] = useState(false);
	const [connectionMessage, setConnectionMessage] = useState("正在连接本地 API…");
	const [project, setProject] = useState<ProjectSnapshot>();
	const projectRef = useRef<ProjectSnapshot | undefined>(undefined);
	const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
	const [releases, setReleases] = useState<ManualRelease[]>([]);
	const [release, setRelease] = useState<ManualRelease>();
	const [report, setReport] = useState<ManualReport>();
	const [busy, setBusy] = useState<"upload" | "generate" | "finalize" | "live">();
	const [recordsLoading, setRecordsLoading] = useState(false);
	const [recordsMessage, setRecordsMessage] = useState("");
	const [recordsTone, setRecordsTone] = useState<"passed" | "failed">("passed");
	const [notice, setNotice] = useState("草稿自动保存在本地服务端。请添加标准程序与测试数据。");
	const [noticeTone, setNoticeTone] = useState<"pending" | "passed" | "failed">("pending");
	const [saveStatus, setSaveStatus] = useState("已保存");
	const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const saveFlight = useRef<Promise<void> | undefined>(undefined);
	const editVersion = useRef(0);
	const savedVersion = useRef(0);

	const showNotice = useCallback((message: string, tone: "pending" | "passed" | "failed" = "pending"): void => {
		setNotice(message);
		setNoticeTone(tone);
	}, []);

	const setCurrentProject = useCallback((snapshot: ProjectSnapshot): void => {
		projectRef.current = snapshot;
		setProject(snapshot);
		localStorage.setItem(currentProjectKey, snapshot.id);
	}, []);

	const checkApiConnection = useCallback(async (origin: string, signal?: AbortSignal): Promise<void> => {
		setApiStatus("checking");
		try {
			const health = await requestJson<{
				sandbox: SandboxStatus;
				capabilities: { aiChat: boolean; liveHydro?: { configured: boolean } };
			}>(apiUrl(origin, "/health"), { signal });
			if (signal?.aborted) return;
			setApiStatus("online");
			setSandbox(health.sandbox);
			setAiConfigured(health.capabilities.aiChat);
			setLiveHydroConfigured(health.capabilities.liveHydro?.configured === true);
			setConnectionMessage("本地制题 API 已连接。");
		} catch (error) {
			if (signal?.aborted) return;
			setApiStatus("offline");
			setConnectionMessage(error instanceof Error ? error.message : "本地 API 连接失败。");
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
	}, [apiOrigin]);

	useEffect(() => {
		const updatePage = (): void => setPage(pageFromHash(window.location.hash));
		window.addEventListener("hashchange", updatePage);
		return () => window.removeEventListener("hashchange", updatePage);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void checkApiConnection(apiOrigin, controller.signal);
		void (async () => {
			try {
				const list = await requestJson<{ projects: ProjectSnapshot[] }>(apiUrl(apiOrigin, "/projects"), {
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setProjects(list.projects);
				const selectedId = localStorage.getItem(currentProjectKey);
				const selected =
					list.projects.find((item) => item.id === selectedId) ??
					list.projects[0] ??
					(await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, "/projects"), {
						method: "POST",
						signal: controller.signal,
					}));
				if (controller.signal.aborted) return;
				setCurrentProject(selected);
				setReport(selected.lastReport);
				if (selected.latestReleaseId) {
					const response = await requestJson<{ releases: ManualRelease[] }>(apiUrl(apiOrigin, "/releases"), {
						signal: controller.signal,
					});
					if (!controller.signal.aborted)
						setRelease(response.releases.find((item) => item.id === selected.latestReleaseId));
				}
			} catch (error) {
				if (!controller.signal.aborted)
					showNotice(error instanceof Error ? error.message : "草稿读取失败。", "failed");
			}
		})();
		return () => controller.abort();
	}, [apiOrigin, checkApiConnection, setCurrentProject, showNotice]);

	useEffect(() => {
		if (page === "records") void refreshRecords();
	}, [page, refreshRecords]);
	useEffect(
		() => () => {
			if (saveTimer.current) clearTimeout(saveTimer.current);
		},
		[],
	);

	async function saveNow(): Promise<void> {
		if (saveTimer.current) {
			clearTimeout(saveTimer.current);
			saveTimer.current = undefined;
		}
		if (saveFlight.current) {
			await saveFlight.current;
			if (savedVersion.current < editVersion.current) await saveNow();
			return;
		}
		const current = projectRef.current;
		if (!current || savedVersion.current >= editVersion.current) return;
		const version = editVersion.current;
		const task = (async () => {
			const saved = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${current.id}`), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(editableProject(current)),
			});
			if (projectRef.current?.id === current.id) {
				const merged = { ...projectRef.current, revision: saved.revision, updatedAt: saved.updatedAt };
				projectRef.current = merged;
				setProject(merged);
			}
			savedVersion.current = version;
			setSaveStatus(savedVersion.current === editVersion.current ? "已保存" : "还有修改待保存");
		})();
		saveFlight.current = task;
		try {
			await task;
		} catch (error) {
			setSaveStatus("保存失败");
			throw error;
		} finally {
			saveFlight.current = undefined;
		}
		if (savedVersion.current < editVersion.current) await saveNow();
	}

	function editProject(change: (current: ProjectSnapshot) => ProjectSnapshot): void {
		const current = projectRef.current;
		if (!current) return;
		const next = change(current);
		projectRef.current = next;
		setProject(next);
		setReport(undefined);
		editVersion.current += 1;
		setSaveStatus("待保存");
		showNotice("草稿已修改，发布前需要重新验证。");
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			void saveNow().catch((error: unknown) =>
				showNotice(error instanceof Error ? error.message : "草稿保存失败。", "failed"),
			);
		}, 650);
	}

	async function newProject(): Promise<void> {
		try {
			await saveNow();
			const created = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, "/projects"), { method: "POST" });
			setCurrentProject(created);
			editVersion.current = 0;
			savedVersion.current = 0;
			setReport(undefined);
			setRelease(undefined);
			setSaveStatus("已保存");
			showNotice("已创建空白草稿；旧项目保留在制题记录中。", "passed");
			window.location.hash = "workspace";
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "创建草稿失败。", "failed");
		}
	}

	async function openProject(id: string): Promise<void> {
		try {
			await saveNow();
			const selected = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${id}`));
			setCurrentProject(selected);
			editVersion.current = 0;
			savedVersion.current = 0;
			setReport(selected.lastReport);
			setRelease(releases.find((item) => item.id === selected.latestReleaseId));
			setSaveStatus("已保存");
			showNotice(`已打开“${selected.title || "未命名题目"}”。`, "passed");
			window.location.hash = "workspace";
		} catch (error) {
			setRecordsMessage(error instanceof Error ? error.message : "项目读取失败。");
			setRecordsTone("failed");
		}
	}

	async function deleteProject(id: string): Promise<void> {
		try {
			const response = await fetch(apiUrl(apiOrigin, `/projects/${id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			if (projectRef.current?.id === id) {
				projectRef.current = undefined;
				setProject(undefined);
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

	async function uploadFiles(files: File[]): Promise<void> {
		const current = projectRef.current;
		if (!current) return;
		setBusy("upload");
		try {
			await saveNow();
			let snapshot = current;
			for (const file of files) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(in|out|ans)$/u.test(file.name))
					throw new Error(`不支持的测试文件名：${file.name}`);
				snapshot = await requestJson<ProjectSnapshot>(
					apiUrl(apiOrigin, `/projects/${current.id}/files/${encodeURIComponent(file.name)}`),
					{
						method: "PUT",
						headers: { "content-type": "application/octet-stream" },
						body: file,
					},
				);
				setCurrentProject(snapshot);
			}
			setReport(undefined);
			showNotice(`已上传 ${files.length} 个测试文件。`, "passed");
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "测试文件上传失败。", "failed");
		} finally {
			setBusy(undefined);
		}
	}

	async function addTextCase(value: {
		name?: string;
		input: string;
		output?: string;
		subtaskId: number;
	}): Promise<void> {
		const current = projectRef.current;
		if (!current) throw new Error("请先创建题目草稿。");
		setBusy("upload");
		try {
			await saveNow();
			const result = await requestJson<{
				inputFile: string;
				outputFile?: string;
				project: ProjectSnapshot;
			}>(apiUrl(apiOrigin, `/projects/${current.id}/cases`), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(value),
			});
			setCurrentProject(result.project);
			setReport(undefined);
			showNotice(
				`已添加 ${result.inputFile}${result.outputFile ? ` 与 ${result.outputFile}` : "，输出将在验证时由标程生成"}。${current.cases.some((item) => item.origin === "generated") ? "已有 Gen 数据，请重跑 Gen 后再打包。" : ""}`,
				"passed",
			);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "添加测试点失败。", "failed");
			throw error;
		} finally {
			setBusy(undefined);
		}
	}

	async function uploadAttachments(files: File[]): Promise<void> {
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
			editProject((current) => ({
				...current,
				attachments: [
					...current.attachments.filter((item) => !additions.some((other) => other.name === item.name)),
					...additions,
				],
			}));
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "附件读取失败。", "failed");
		}
	}

	async function deleteFile(name: string): Promise<void> {
		const current = projectRef.current;
		if (!current) return;
		try {
			await saveNow();
			const snapshot = await requestJson<ProjectSnapshot>(
				apiUrl(apiOrigin, `/projects/${current.id}/files/${encodeURIComponent(name)}`),
				{ method: "DELETE" },
			);
			setCurrentProject(snapshot);
			setReport(undefined);
			showNotice(`已删除 ${name}。`, "passed");
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "删除文件失败。", "failed");
		}
	}

	async function generate(): Promise<void> {
		const current = projectRef.current;
		if (!current) return;
		setBusy("generate");
		showNotice("正在编译 Gen 和标程，逐条生成并复现检查…");
		try {
			await saveNow();
			const result = await requestJson<{ project: ProjectSnapshot; report: ManualReport }>(
				apiUrl(apiOrigin, `/projects/${current.id}/generate`),
				{ method: "POST" },
			);
			setCurrentProject(result.project);
			setReport(result.report);
			showNotice(
				result.report.success
					? `生成 ${result.report.generatedCount} 个测试点，标准程序${result.report.oracleCount ? "与第二标准程序交叉核验" : "运行"}通过。`
					: "Gen 或数据检查失败，上一批生成点已保留。请查看验证报告。",
				result.report.success ? "passed" : "failed",
			);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "生成失败。", "failed");
		} finally {
			setBusy(undefined);
		}
	}

	async function finalize(): Promise<void> {
		const current = projectRef.current;
		if (!current) return;
		setBusy("finalize");
		showNotice("正在完整验证测试数据与程序，并生成 Hydro 包…");
		try {
			await saveNow();
			const result = await requestJson<{ release?: ManualRelease; report: ManualReport }>(
				apiUrl(apiOrigin, `/projects/${current.id}/finalize`),
				{ method: "POST" },
			);
			setReport(result.report);
			if (result.release) setRelease(result.release);
			const refreshed = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `/projects/${current.id}`));
			setCurrentProject(refreshed);
			showNotice(
				result.release
					? "本地完整验证与 Hydro 目录检查通过，两个包均可下载。"
					: "完整验证未通过，未生成新的下载包。请查看失败项。",
				result.release ? "passed" : "failed",
			);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "验证或打包失败。", "failed");
		} finally {
			setBusy(undefined);
		}
	}

	async function liveVerify(): Promise<void> {
		if (!release) return;
		setBusy("live");
		showNotice("正在真实 Hydro 上导入并评测已发布版本…");
		try {
			const result = await requestJson<{
				success: boolean;
				message: string;
				problemUrl?: string;
				reference: { verdict: string; score?: number; accepted: boolean };
			}>(apiUrl(apiOrigin, `/releases/${release.id}/live-verify`), { method: "POST" });
			setRelease({ ...release, liveVerification: result });
			setReleases((current) =>
				current.map((item) => (item.id === release.id ? { ...item, liveVerification: result } : item)),
			);
			showNotice(
				result.success ? "真实 Hydro 实测通过。" : "真实 Hydro 实测未通过，请检查适配器结果。",
				result.success ? "passed" : "failed",
			);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "真实 Hydro 实测失败。", "failed");
		} finally {
			setBusy(undefined);
		}
	}

	function saveApiConfiguration(): void {
		try {
			const origin = normalizeApiOrigin(apiOriginDraft);
			if (origin) localStorage.setItem(originKey, origin);
			else localStorage.removeItem(originKey);
			setApiOriginDraft(origin);
			if (origin === apiOrigin) void checkApiConnection(origin);
			else setApiOrigin(origin);
		} catch (error) {
			setConnectionMessage(error instanceof Error ? error.message : "API 地址无效。");
		}
	}

	return (
		<>
			<header className="site-header">
				<div className="header-inner">
					<a className="brand" href="#workspace" aria-label="Hydro Problem Make 首页">
						<span className="brand-mark">H</span>
						<span>Hydro Problem Make</span>
					</a>
					<nav className="main-nav" aria-label="主导航">
						<a className={page === "workspace" ? "active" : ""} href="#workspace">
							制题工作台
						</a>
						<a className={page === "chat" ? "active" : ""} href="#chat">
							AI 对话
						</a>
						<a className={page === "records" ? "active" : ""} href="#records">
							制题记录
						</a>
						<a className={page === "settings" ? "active" : ""} href="#settings">
							设置
						</a>
					</nav>
					<button
						className={`api-pill ${apiStatus}`}
						type="button"
						onClick={() => {
							window.location.hash = "settings";
						}}
					>
						{apiStatusLabel(apiStatus)}
					</button>
				</div>
			</header>
			{page === "workspace" &&
				(project ? (
					<ManualWorkspace
						key={project.id}
						apiOrigin={apiOrigin}
						project={project}
						release={release}
						report={report}
						sandbox={sandbox}
						liveHydroConfigured={liveHydroConfigured}
						busy={busy}
						saveStatus={saveStatus}
						notice={notice}
						noticeTone={noticeTone}
						onEdit={editProject}
						onUpload={uploadFiles}
						onAddCase={addTextCase}
						onUploadAttachments={uploadAttachments}
						onDeleteFile={deleteFile}
						onGenerate={generate}
						onFinalize={finalize}
						onNew={newProject}
						onLiveVerify={liveVerify}
					/>
				) : (
					<main className="page">
						<output className={`notice ${noticeTone}`} aria-live="polite">
							正在读取草稿… {notice}
						</output>
						<button className="button primary" type="button" onClick={() => void newProject()}>
							新建题目
						</button>
					</main>
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
				/>
			)}
			{page === "settings" && (
				<SettingsPage
					apiOrigin={apiOrigin}
					apiOriginDraft={apiOriginDraft}
					apiStatus={apiStatus}
					sandbox={sandbox}
					connectionMessage={connectionMessage}
					onApiOriginChange={setApiOriginDraft}
					onSave={saveApiConfiguration}
					onReset={() => {
						localStorage.removeItem(originKey);
						setApiOriginDraft("");
						setApiOrigin("");
					}}
					onAiConfigurationChanged={() => void checkApiConnection(apiOrigin)}
				/>
			)}
			<footer>Hydro Problem Make · 文件式数据流水线 · C++ testlib SPJ</footer>
		</>
	);
}
