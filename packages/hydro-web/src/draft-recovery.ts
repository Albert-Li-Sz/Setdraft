import { type ProjectSnapshot, readProjectSnapshot } from "@setdraft/contracts";
import { createClientId } from "./browser-capabilities.ts";

export interface DraftRecovery {
	id: string;
	userId: string;
	savedAt: string;
	base: ProjectSnapshot;
	project: ProjectSnapshot;
}
const prefix = "setdraft.unsaved.v1:";
const lifetime = 14 * 24 * 60 * 60 * 1000;
export class DraftRecoveryStore {
	private readonly storage: Storage;
	private readonly userId: string;
	private readonly own = new Map<string, string>();
	constructor(storage: Storage, userId: string) {
		this.storage = storage;
		this.userId = userId;
	}
	private userPrefix() {
		return `${prefix}${this.userId}:`;
	}
	list(projectId?: string): DraftRecovery[] {
		const entries: DraftRecovery[] = [];
		for (let index = this.storage.length - 1; index >= 0; index--) {
			const key = this.storage.key(index);
			if (!key?.startsWith(this.userPrefix())) continue;
			try {
				const value: unknown = JSON.parse(this.storage.getItem(key) ?? "null");
				if (!value || typeof value !== "object") continue;
				const record = value as DraftRecovery;
				if (record.id !== key || record.userId !== this.userId || !Number.isFinite(Date.parse(record.savedAt)))
					continue;
				if (Date.now() - Date.parse(record.savedAt) > lifetime) {
					this.storage.removeItem(key);
					continue;
				}
				const project = readProjectSnapshot(record.project),
					base = readProjectSnapshot(record.base);
				if (base.id !== project.id || (projectId && project.id !== projectId) || this.own.get(project.id) === key)
					continue;
				entries.push({ ...record, project, base });
			} catch {
				/* A corrupt local entry is never adopted as editable content. */
			}
		}
		return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
	}
	write(base: ProjectSnapshot, project: ProjectSnapshot): void {
		let id = this.own.get(project.id);
		if (!id) {
			id = `${this.userPrefix()}${project.id}:${createClientId()}`;
			this.own.set(project.id, id);
		}
		const value = JSON.stringify({ id, userId: this.userId, savedAt: new Date().toISOString(), base, project });
		if (new Blob([value]).size > 8 * 1024 * 1024)
			throw new Error("未保存内容超过浏览器恢复容量，请保持页面开启并完成保存。");
		this.storage.setItem(id, value);
		// Bound abandoned entries; never overwrite another active tab's recovery record.
		for (const entry of this.list().slice(20))
			if (Date.now() - Date.parse(entry.savedAt) > 24 * 60 * 60 * 1000) this.storage.removeItem(entry.id);
	}
	saved(projectId: string): void {
		const id = this.own.get(projectId);
		if (id) this.storage.removeItem(id);
		this.own.delete(projectId);
	}
	discard(id: string): void {
		if (id.startsWith(this.userPrefix())) this.storage.removeItem(id);
	}
}
