import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import { AuthRoot } from "./AuthRoot.tsx";
import { LocaleProvider } from "./i18n.tsx";
import "./styles.css";
import "./shell.css";
import "./auth.css";
import "./problem-center.css";
import "./workspace-refinements.css";
import "./responsive-workspace.css";
import "./verification.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

createRoot(root).render(
	<StrictMode>
		<LocaleProvider>
			<AuthRoot />
		</LocaleProvider>
	</StrictMode>,
);
