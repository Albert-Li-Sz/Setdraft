import { AiApiSettings } from "./AiApiSettings.tsx";
import type { ApiStatus, SandboxStatus } from "./platform.ts";
import { apiStatusLabel } from "./platform.ts";

interface SettingsPageProps {
	apiOrigin: string;
	apiOriginDraft: string;
	apiStatus: ApiStatus;
	agentAvailable: boolean;
	agentModels: readonly string[];
	sandbox?: SandboxStatus;
	connectionMessage: string;
	onApiOriginChange: (value: string) => void;
	onSave: () => void;
	onReset: () => void;
	onAiConfigurationChanged: () => void;
}

export function SettingsPage(props: SettingsPageProps) {
	return (
		<main className="page settings-page" id="settings">
			<div className="breadcrumb">系统 / 设置</div>
			<section className="page-heading settings-heading">
				<div>
					<div className="eyebrow">平台配置</div>
					<h1>设置</h1>
					<p>从网页配置 Pi Agent，运行制题 Skill，并在任务完成后下载 Hydro 导入包。</p>
				</div>
			</section>

			<div className="settings-grid">
				<AiApiSettings apiOrigin={props.apiOrigin} onConfigurationChanged={props.onAiConfigurationChanged} />

				<aside className="settings-side">
					<section className="card settings-card">
						<h2>Pi Agent 状态</h2>
						<div className="service-state">
							<span className={props.agentAvailable ? "service-dot ready" : "service-dot"} />
							<div>
								<strong>{props.agentAvailable ? "Agent 生成已启用" : "Agent 生成未配置"}</strong>
								<small>
									{props.agentAvailable
										? `${props.agentModels.length} 个模型可用`
										: "格式检查与确定性打包仍可使用"}
								</small>
							</div>
						</div>
						{props.agentModels.length > 0 && (
							<ul className="model-list">
								{props.agentModels.map((model) => (
									<li key={model}>{model}</li>
								))}
							</ul>
						)}
						<p className="settings-help">启用后，工作台的“运行 Pi Agent”会创建后台任务，并实时显示生成进度。</p>
					</section>

					<section className="card settings-card api-settings-card">
						<div className="settings-card-heading compact-heading">
							<div>
								<h2>平台连接</h2>
								<p>本地前端连接 Hydro Problem Make API 的地址。</p>
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
								spellCheck={false}
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
						<output className={`connection-result ${props.apiStatus}`}>
							<span className="notice-dot" />
							{props.connectionMessage}
						</output>
					</section>

					<section className="card settings-card">
						<h2>运行环境</h2>
						<dl className="settings-definition-list compact">
							<div>
								<dt>Skill</dt>
								<dd>hydro-problem-authoring</dd>
							</div>
							<div>
								<dt>任务队列</dt>
								<dd>默认双并发 · 本地保存 · 支持续接</dd>
							</div>
							<div>
								<dt>模型预算</dt>
								<dd>上下文与输出长度可独立设置</dd>
							</div>
							<div>
								<dt>Linux 沙箱</dt>
								<dd className={props.sandbox?.available ? "" : "warning-text"}>
									{props.sandbox?.message ?? "正在检测……"}
								</dd>
							</div>
						</dl>
					</section>
				</aside>
			</div>
		</main>
	);
}
