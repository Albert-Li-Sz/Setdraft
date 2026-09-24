import { AiApiSettings } from "./AiApiSettings.tsx";
import { type ApiStatus, apiStatusLabel, type SandboxStatus } from "./platform.ts";

interface SettingsPageProps {
	apiOrigin: string;
	apiOriginDraft: string;
	apiStatus: ApiStatus;
	sandbox?: SandboxStatus;
	connectionMessage: string;
	onApiOriginChange(value: string): void;
	onSave(): void;
	onReset(): void;
	onAiConfigurationChanged(): void;
}

export function SettingsPage(props: SettingsPageProps) {
	return (
		<main className="page settings-page" id="settings">
			<div className="breadcrumb">系统 / 设置</div>
			<section className="page-heading settings-heading">
				<div>
					<div className="eyebrow">平台配置</div>
					<h1>设置</h1>
					<p>配置 AI 对话与本地制题服务；手工制题不需要 AI API。</p>
				</div>
			</section>
			<div className="settings-grid">
				<AiApiSettings apiOrigin={props.apiOrigin} onConfigurationChanged={props.onAiConfigurationChanged} />
				<aside className="settings-side">
					<section className="card settings-card api-settings-card">
						<div className="settings-card-heading compact-heading">
							<div>
								<h2>平台连接</h2>
								<p>本地前端连接制题 API 的地址。</p>
							</div>
							<span className={`status-badge ${props.apiStatus}`}>{apiStatusLabel(props.apiStatus)}</span>
						</div>
						<label className="field settings-field">
							<span>平台 API 根地址</span>
							<input
								aria-label="平台 API 根地址"
								value={props.apiOriginDraft}
								onChange={(event) => props.onApiOriginChange(event.target.value)}
								placeholder="留空使用当前站点"
							/>
						</label>
						<div className="settings-actions">
							<button className="button primary" type="button" onClick={props.onSave}>
								保存并检测
							</button>
							<button className="button secondary" type="button" onClick={props.onReset}>
								恢复同源
							</button>
						</div>
						<output className={`connection-result ${props.apiStatus}`} aria-live="polite">
							{props.connectionMessage}
						</output>
					</section>
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
