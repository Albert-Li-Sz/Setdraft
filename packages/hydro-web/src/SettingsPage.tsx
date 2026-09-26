import { useState } from "react";
import { AiApiSettings } from "./AiApiSettings.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import { apiUrl, type BackgroundTask, type SandboxStatus, waitForTask } from "./platform.ts";

interface SettingsPageProps {
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
			const response = await fetch(apiUrl(props.apiOrigin, "/sandbox/build"), { method: "POST" });
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
			<div className="breadcrumb">{t("系统 / 设置")}</div>
			<section className="page-heading settings-heading">
				<div>
					<div className="eyebrow">{t("AI 与运行环境")}</div>
					<h1>{t("设置")}</h1>
					<p>{t("配置 AI 对话与本地沙箱；手工制题不需要 AI API。")}</p>
				</div>
			</section>
			<div className="settings-grid">
				<AiApiSettings apiOrigin={props.apiOrigin} onConfigurationChanged={props.onAiConfigurationChanged} />
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
							<button
								className="button primary"
								type="button"
								disabled={building || props.sandbox?.state === "daemon-unavailable"}
								onClick={() => void build()}
							>
								{building ? t("构建中…") : t("构建镜像")}
							</button>
						</div>
						{message && (
							<output className="notice pending" aria-live="polite">
								{t(message)}
							</output>
						)}
					</section>
				</aside>
			</div>
		</main>
	);
}
