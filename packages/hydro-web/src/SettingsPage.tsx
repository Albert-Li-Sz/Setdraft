import type { AuthUser } from "@hydro-problem-make/contracts";
import { useState } from "react";
import { AdminUsers } from "./AdminUsers.tsx";
import { AiApiSettings } from "./AiApiSettings.tsx";
import { authFetch } from "./auth-client.ts";
import { type UiMessage, useLocale } from "./i18n.tsx";
import { apiUrl, type BackgroundTask, type SandboxStatus, waitForTask } from "./platform.ts";

interface SettingsPageProps {
	user: AuthUser;
	apiOrigin: string;
	sandbox?: SandboxStatus;
	onAiConfigurationChanged(): void;
	onRefreshSandbox(): void;
}

export function SettingsPage(props: SettingsPageProps) {
	const { t } = useLocale();
	const [building, setBuilding] = useState(false);
	const [message, setMessage] = useState<UiMessage>("");
	async function build(): Promise<void> {
		setBuilding(true);
		setMessage("正在构建沙盒镜像…");
		try {
			const response = await authFetch(apiUrl(props.apiOrigin, "/sandbox/build"), { method: "POST" });
			const body = (await response.json()) as { task?: BackgroundTask; message?: string };
			if (!response.ok || !body.task) throw new Error(body.message ?? "无法创建构建任务。");
			await waitForTask(props.apiOrigin, body.task.id);
			props.onRefreshSandbox();
			setMessage("镜像构建完成。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "镜像构建失败。");
		} finally {
			setBuilding(false);
		}
	}
	return (
		<main className="page settings-page" id="settings">
			<section className="page-heading settings-heading">
				<div>
					<h1>{t("设置")}</h1>
					<p>{t(props.user.role === "admin" ? "管理团队 AI 配置、沙箱与账号。" : "AI 模型由管理员统一配置。")}</p>
				</div>
			</section>
			<div className="settings-grid">
				{props.user.role === "admin" ? (
					<AiApiSettings apiOrigin={props.apiOrigin} onConfigurationChanged={props.onAiConfigurationChanged} />
				) : (
					<section className="card settings-card">
						<h2>{t("团队 AI")}</h2>
						<p className="settings-help">{t("在 AI 对话中选择团队模型。需要调整配置时，请联系管理员。")}</p>
					</section>
				)}
				<aside className="settings-side">
					<section className="card settings-card">
						<h2>{t("Linux 沙箱")}</h2>
						<p className="settings-help">
							{t("Gen、标准程序、可选第二标准程序、输入校验器和 SPJ 在隔离容器内运行。")}
						</p>
						<span className={`status-badge ${props.sandbox?.available ? "online" : "offline"}`}>
							{props.sandbox?.message ? t(props.sandbox.message) : t("正在检测……")}
						</span>
						<p className="settings-help">
							{props.sandbox?.state === "daemon-unavailable"
								? t("请先启动 Docker Desktop 或 Docker 守护进程，再重新检测。")
								: props.sandbox?.state === "image-missing"
									? t("Docker 已运行；构建沙盒镜像后即可验证题目。")
									: t("沙盒支持 GCC 16.2；C++26 为实验性标准。")}
						</p>
						<div className="heading-actions">
							<button className="button secondary" type="button" onClick={props.onRefreshSandbox}>
								{t("重新检测")}
							</button>
							{props.user.role === "admin" && (
								<button
									className="button primary"
									type="button"
									disabled={building || props.sandbox?.state === "daemon-unavailable"}
									onClick={() => void build()}
								>
									{building ? t("构建中…") : t("构建镜像")}
								</button>
							)}
						</div>
						{message && (
							<output className="notice pending" aria-live="polite">
								{t(message)}
							</output>
						)}
					</section>
				</aside>
			</div>
			{props.user.role === "admin" && <AdminUsers />}
		</main>
	);
}
