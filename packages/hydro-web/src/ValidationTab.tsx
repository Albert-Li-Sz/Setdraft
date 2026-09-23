import { AgentRunPanel } from "./AgentRunPanel.tsx";
import type { AgentRun, ValidationReport } from "./platform.ts";

interface Props {
	run?: AgentRun;
	apiOrigin: string;
	agentClass: string;
	busy: boolean;
	agentAvailable: boolean;
	hasReferenceProgram: boolean;
	continuationMessage: string;
	validation?: ValidationReport;
	validationClass: string;
	liveHydroConfigured: boolean;
	liveBusy: boolean;
	onContinuationMessageChange: (message: string) => void;
	onContinue: (message: string) => Promise<boolean>;
	onRetry: () => Promise<boolean>;
	onCancel: () => void;
	onEditProgram: () => void;
	onLiveVerify: () => void;
}

export function ValidationTab(props: Props) {
	return (
		<div className="tab-body validation-body">
			{props.run && (
				<AgentRunPanel
					key={props.run.id}
					run={props.run}
					apiOrigin={props.apiOrigin}
					className={props.agentClass}
					busy={props.busy}
					available={props.agentAvailable}
					hasReferenceProgram={props.hasReferenceProgram}
					message={props.continuationMessage}
					onMessageChange={props.onContinuationMessageChange}
					onContinue={props.onContinue}
					onRetry={props.onRetry}
					onCancel={props.onCancel}
					onEditProgram={props.onEditProgram}
					liveHydroConfigured={props.liveHydroConfigured}
					liveBusy={props.liveBusy}
					onLiveVerify={props.onLiveVerify}
				/>
			)}
			<div className={`validation-summary ${props.validationClass}`}>
				<div className="summary-icon">
					{props.validation?.valid === true ? "✓" : props.validation === undefined ? "…" : "!"}
				</div>
				<div>
					<strong>
						{props.validation?.valid === true
							? "Hydro 格式检查通过"
							: props.validation === undefined
								? "尚未运行格式检查"
								: "Hydro 格式检查未通过"}
					</strong>
					<p>该检查覆盖包结构、文件引用、限制单位、计分与比较器配置。</p>
				</div>
			</div>
			{props.validation !== undefined && props.validation.issues.length > 0 && (
				<table className="issues-table">
					<thead>
						<tr>
							<th>位置</th>
							<th>代码</th>
							<th>说明</th>
						</tr>
					</thead>
					<tbody>
						{props.validation.issues.map((issue, index) => (
							<tr key={`${issue.code}-${issue.path}-${index}`}>
								<td>{issue.path}</td>
								<td>
									<code>{issue.code}</code>
								</td>
								<td>{issue.message}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="evidence-grid">
				<div>
					<span>格式与目录</span>
					<strong>{props.validation?.valid === true ? "通过" : "待检查"}</strong>
				</div>
				<div>
					<span>标准程序校验</span>
					<strong>
						{props.run?.artifact?.verification?.success
							? `${props.run.artifact.verification.cases.length} 个测试点通过`
							: "未执行"}
					</strong>
				</div>
				<div>
					<span>真实 Hydro 导入</span>
					<strong>
						{props.run?.artifact?.liveVerification?.success
							? "标程 AC/100，错误程序均被拒绝"
							: props.run?.artifact?.liveVerification
								? "实测未通过"
								: props.liveHydroConfigured
									? "待运行"
									: "未配置"}
					</strong>
				</div>
			</div>
		</div>
	);
}
