import type { AiConfiguration, CppLanguage } from "@setdraft/contracts";

export * from "@setdraft/contracts";
export { apiUrl, requestJson, responseError, waitForTask } from "./api-client.ts";
export type PageRoute =
	| "workspace"
	| "chat"
	| "records"
	| "contests"
	| "tasks"
	| "settings"
	| "admin"
	| "authoring-guide";
export type ApiStatus = "checking" | "online" | "offline";

export const cppLanguageOptions: ReadonlyArray<{ value: CppLanguage; label: string }> = [
	{ value: "cpp11", label: "C++11" },
	{ value: "cpp14", label: "C++14" },
	{ value: "cpp17", label: "C++17" },
	{ value: "cpp20", label: "C++20" },
	{ value: "cpp23", label: "C++23" },
	{ value: "cpp26", label: "C++26（实验性）" },
];

export function pageFromHash(hash: string): PageRoute {
	hash = hash.split("?")[0];
	if (hash === "#chat") return "chat";
	if (hash === "#records") return "records";
	if (hash === "#contests") return "contests";
	if (hash === "#tasks") return "tasks";
	if (hash === "#admin") return "admin";
	if (hash === "#settings") return "settings";
	if (hash === "#authoring-guide") return "authoring-guide";
	return "workspace";
}

export function normalizeApiOrigin(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("API 根地址必须是完整的 http:// 或 https:// 地址。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("API 根地址只支持 http:// 或 https://。");
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("API 根地址只填写协议、域名和端口。");
	}
	return url.origin;
}

export function apiStatusLabel(status: ApiStatus): string {
	if (status === "online") return "API 已连接";
	if (status === "offline") return "API 未连接";
	return "正在连接 API";
}

export function readAiConfiguration(value: unknown): AiConfiguration | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.configured !== "boolean" || !Array.isArray(record.profiles) || !Array.isArray(record.providers))
		return undefined;
	if (Object.hasOwn(record, "apiKey")) return undefined;
	for (const profile of record.profiles) {
		if (
			typeof profile !== "object" ||
			profile === null ||
			Array.isArray(profile) ||
			typeof profile.id !== "string" ||
			typeof profile.name !== "string" ||
			typeof profile.provider !== "string" ||
			typeof profile.modelId !== "string" ||
			typeof profile.contextWindow !== "number" ||
			typeof profile.maxTokens !== "number" ||
			typeof profile.apiKeyConfigured !== "boolean" ||
			Object.hasOwn(profile, "apiKey")
		)
			return undefined;
	}
	for (const provider of record.providers) {
		if (
			typeof provider !== "object" ||
			provider === null ||
			typeof provider.id !== "string" ||
			typeof provider.name !== "string"
		)
			return undefined;
	}
	return value as AiConfiguration;
}
