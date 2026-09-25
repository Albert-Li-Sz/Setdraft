import type { OAuthCredentials } from "../auth/types.ts";

/** OAuth prompt shown by an optional provider integration. */
export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}

/** OAuth authorization link shown by an optional provider integration. */
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

/** OAuth device-code notification shown by an optional provider integration. */
export interface OAuthDeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface OAuthSelectOption {
	id: string;
	label: string;
}

export interface OAuthSelectPrompt {
	message: string;
	options: OAuthSelectOption[];
}

/** Callback surface shared by optional OAuth integrations. */
export interface OAuthLoginCallbacks {
	onAuth(info: OAuthAuthInfo): void;
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	signal?: AbortSignal;
}

export type { OAuthCredentials };
