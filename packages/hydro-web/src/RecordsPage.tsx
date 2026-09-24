import { useState } from "react";
import { apiUrl, type ManualRelease, type ProjectSnapshot } from "./platform.ts";

interface Props {
	apiOrigin: string;
	projects: ProjectSnapshot[];
	releases: ManualRelease[];
	loading: boolean;
	message: string;
	tone: "passed" | "failed";
	onRefresh(): Promise<void>;
	onOpen(id: string): Promise<void>;
	onDelete(id: string): Promise<void>;
}

export function RecordsPage(props: Props) {
	const [pendingDelete, setPendingDelete] = useState<ProjectSnapshot>();
	return (
		<main className="page" id="records">
			<div className="breadcrumb">题库 / 制题记录</div>
			<section className="page-heading">
				<div>
					<div className="eyebrow">本地记录</div>
					<h1>制题记录</h1>
					<p>草稿可重新打开；已通过验证的历史包保持可下载。</p>
				</div>
				<button
					className="button secondary"
					type="button"
					onClick={() => void props.onRefresh()}
					disabled={props.loading}
				>
					{props.loading ? "刷新中…" : "刷新记录"}
				</button>
			</section>
			{(props.loading || props.message) && (
				<output className={`notice ${props.loading ? "pending" : props.tone}`} aria-live="polite">
					<span className="notice-dot" />
					{props.loading ? "正在读取制题记录…" : props.message}
				</output>
			)}
			<section className="card manual-record-card">
				<div className="manual-section-heading">
					<div>
						<h2>草稿</h2>
						<p>{props.projects.length} 个本地项目</p>
					</div>
				</div>
				<div className="history-table-wrap">
					<table className="history-table">
						<thead>
							<tr>
								<th>题目</th>
								<th>版本</th>
								<th>测试点</th>
								<th>最后修改</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{props.projects.map((item) => (
								<tr key={item.id}>
									<td>
										<strong>{item.title || "未命名题目"}</strong>
										<code>{item.slug || item.id}</code>
									</td>
									<td>{item.revision}</td>
									<td>{item.cases.length}</td>
									<td>{new Date(item.updatedAt).toLocaleString("zh-CN")}</td>
									<td>
										<div className="history-actions">
											<button type="button" onClick={() => void props.onOpen(item.id)}>
												继续编辑
											</button>
											<button type="button" className="danger" onClick={() => setPendingDelete(item)}>
												删除
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{props.projects.length === 0 && <p className="manual-muted">暂无草稿。</p>}
				</div>
			</section>
			<section className="card manual-record-card">
				<div className="manual-section-heading">
					<div>
						<h2>已验证发布包</h2>
						<p>每条记录与对应草稿版本、文件哈希和验证报告绑定。</p>
					</div>
				</div>
				<div className="history-table-wrap">
					<table className="history-table">
						<thead>
							<tr>
								<th>题目</th>
								<th>草稿版本</th>
								<th>测试点</th>
								<th>发布时间</th>
								<th>真实 Hydro</th>
								<th>下载</th>
							</tr>
						</thead>
						<tbody>
							{props.releases.map((item) => (
								<tr key={item.id}>
									<td>
										<strong>{item.title}</strong>
										<code>
											{item.slug} · {item.id.slice(0, 8)}
										</code>
									</td>
									<td>{item.revision}</td>
									<td>{item.report.caseCount}</td>
									<td>{new Date(item.createdAt).toLocaleString("zh-CN")}</td>
									<td>
										{item.liveVerification
											? `${item.liveVerification.success ? "通过" : "未通过"} · ${item.liveVerification.reference.verdict}`
											: "未运行（可选）"}
									</td>
									<td>
										<div className="history-actions">
											<a
												href={apiUrl(props.apiOrigin, `/releases/${item.id}/hydro`)}
												download={`${item.slug}.hydro.zip`}
											>
												Hydro 包
											</a>
											<a
												href={apiUrl(props.apiOrigin, `/releases/${item.id}/source`)}
												download={`${item.slug}.authoring.zip`}
											>
												制题工程
											</a>
											<a
												href={apiUrl(props.apiOrigin, `/releases/${item.id}/report`)}
												target="_blank"
												rel="noreferrer"
											>
												报告
											</a>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{props.releases.length === 0 && <p className="manual-muted">暂无通过完整验证的发布包。</p>}
				</div>
			</section>
			{pendingDelete && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="delete-project-title"
					>
						<div className="confirmation-heading">
							<span>删除确认</span>
							<h2 id="delete-project-title">删除“{pendingDelete.title || "未命名题目"}”？</h2>
						</div>
						<p>这会删除草稿、测试数据与该项目的所有发布包，无法撤销。</p>
						<code>{pendingDelete.id}</code>
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setPendingDelete(undefined)}>
								取消
							</button>
							<button
								className="button primary"
								type="button"
								onClick={() => {
									const id = pendingDelete.id;
									setPendingDelete(undefined);
									void props.onDelete(id);
								}}
							>
								确认删除
							</button>
						</div>
					</div>
				</div>
			)}
		</main>
	);
}
