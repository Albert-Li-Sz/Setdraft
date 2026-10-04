declare const __SETDRAFT_VERSION__: string;

// Vite injects the root package version for both development and release assets.
export const appVersion = typeof __SETDRAFT_VERSION__ === "string" ? `v${__SETDRAFT_VERSION__}` : "dev";
