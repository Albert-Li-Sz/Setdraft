import { AiApiSettings } from "./AiApiSettings.tsx";
import type { SandboxStatus } from "./platform.ts";

interface SettingsPageProps {
	apiOrigin: string;
	sandbox?: SandboxStatus;
	onAiConfigurationChanged(): void;
}

export function SettingsPage(props: SettingsPageProps) {
	return (
		<main className="page settings-page" id="settings">
			<div className="breadcrumb">系统 / 设置</div>
			<section className="page-heading settings-heading">
				<div>
					<div className="eyebrow">AI 与运行环境</div>
					<h1>设置</h1>
					<p>配置 AI 对话与本地沙箱；手工制题不需要 AI API。</p>
				</div>
			</section>
			<div className="settings-grid">
				<AiApiSettings apiOrigin={props.apiOrigin} onConfigurationChanged={props.onAiConfigurationChanged} />
				<aside className="settings-side">
					<section className="card settings-card">
						<h2>Linux 沙箱</h2>
						<p className="settings-help">Gen、标准程序、可选第二标准程序、输入校验器和 SPJ 在隔离容器内运行。</p>
						<span className={`status-badge ${props.sandbox?.available ? "online" : "offline"}`}>
							{props.sandbox?.message ?? "正在检测……"}
						</span>
					</section>
				</aside>
			</div>
		</main>
	);
}
