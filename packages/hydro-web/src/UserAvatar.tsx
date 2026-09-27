import type { AuthUser } from "@hydro-problem-make/contracts";
export function UserAvatar({ user, large = false }: { user: Pick<AuthUser, "username" | "avatar">; large?: boolean }) {
	return (
		<span className={`workspace-avatar${large ? " profile-avatar" : ""}`}>
			{user.avatar ? <img src={user.avatar} alt="" /> : user.username.slice(0, 1).toUpperCase()}
		</span>
	);
}
