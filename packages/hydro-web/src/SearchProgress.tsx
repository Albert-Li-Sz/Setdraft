import type { SearchQueryResult } from "@setdraft/contracts";
import { useLocale } from "./i18n.tsx";

export function SearchProgress({ queries, results }: { queries: string[]; results?: SearchQueryResult[] }) {
	const { t } = useLocale();
	return (
		<ol className="search-query-results" aria-label={t("搜索进度")}>
			{queries.map((query) => {
				const result = results?.find((item) => item.query === query);
				const status =
					result?.state === "cancelled"
						? "已取消"
						: result?.state === "pending"
							? "等待搜索"
							: result?.state === "searching" || !result
								? "搜索中"
								: result.status === "partial"
									? "部分搜索完成"
									: result.status === "healthy"
										? "搜索完成"
										: "搜索失败";
				return (
					<li key={query}>
						<strong>{query}</strong>
						<div className="search-query-meta">
							<span>{t(status)}</span>
							{result?.count !== undefined && <span>{t("{0} 条结果", result.count)}</span>}
							{result?.durationMs !== undefined && (
								<span>{t("耗时 {0} 秒", (result.durationMs / 1000).toFixed(2))}</span>
							)}
							{result?.cached && <span>{t("已复用搜索结果")}</span>}
						</div>
						{result?.message && <p className="chat-search-warning">{t(result.message)}</p>}
					</li>
				);
			})}
		</ol>
	);
}
