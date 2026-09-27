import { fileURLToPath } from "node:url";
import { workspaceRoot } from "./environment.ts";
import { IdentityStore } from "./identity.ts";

const root = workspaceRoot(fileURLToPath(new URL("../../..", import.meta.url)));
const identity = new IdentityStore(root);
try {
	const [command, name, ...extra] = process.argv.slice(2);
	if (command === "setup-code" && !name) {
		console.log(`Setdraft 一次性安装码（24 小时有效）：${identity.rotateSetupToken()}`);
	} else if (command === "reset-password" && name && extra.length === 0) {
		const user = identity.listUsers().find((item) => item.username === name.toLowerCase());
		if (!user) throw new Error("账号不存在。");
		const result = await identity.resetPassword(undefined, user.id);
		console.log(`${user.username} 的临时密码（首次登录必须修改）：${result.temporaryPassword}`);
	} else throw new Error("用法：account setup-code | account reset-password <用户名>");
} finally {
	identity.close();
}
