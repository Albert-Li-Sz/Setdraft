// Shared by the dependency-free installer and the administrator's image-build task.
export function sandboxBuildArgs(environment) {
	const args = [];
	const registry = environment.HYDRO_DOCKER_REGISTRY;
	if (registry) {
		if (!/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._-]+)*$/u.test(registry)) throw new Error("Docker 镜像仓库地址无效。");
		args.push("--build-arg", `PYTHON_IMAGE=${registry}/library/python:3.14-slim-trixie`);
		args.push("--build-arg", `GCC_IMAGE=${registry}/library/gcc:16.2.0-trixie@sha256:28365a1efe31883fd29f9fce27811b731e815f9f9b2db16b0e1f0d99fcb3dae5`);
	}
	if (environment.HYDRO_DEBIAN_MIRROR) {
		const url = new URL(environment.HYDRO_DEBIAN_MIRROR);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Debian 镜像需要无凭据的 HTTPS 地址。");
		args.push("--build-arg", `DEBIAN_MIRROR=${environment.HYDRO_DEBIAN_MIRROR.replace(/\/$/u, "")}`);
	}
	return args;
}
