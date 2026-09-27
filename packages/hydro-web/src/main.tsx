import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import { App } from "./App.tsx";
import { LocaleProvider } from "./i18n.tsx";
import "./styles.css";
import "./shell.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

createRoot(root).render(
	<StrictMode>
		<LocaleProvider>
			<App />
		</LocaleProvider>
	</StrictMode>,
);
