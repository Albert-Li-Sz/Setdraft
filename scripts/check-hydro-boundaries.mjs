import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = resolve(root, "packages/hydro-server/src");
const webRoot = resolve(root, "packages/hydro-web/src");
const contractsRoot = resolve(root, "packages/hydro-contracts/src");
const failures = [];

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/u.test(entry.name) ? [path] : [];
	});
}

function imports(path) {
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const result = [];
	function visit(node) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			const specifier = node.moduleSpecifier;
			if (specifier && ts.isStringLiteral(specifier)) {
				const clause = ts.isImportDeclaration(node) ? node.importClause : node;
				const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
				const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings?.elements?.length > 0 && bindings.elements.every((item) => item.isTypeOnly));
				result.push({ specifier: specifier.text, typeOnly });
			}
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
			result.push({ specifier: node.arguments[0].text, typeOnly: false });
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return result;
}

const files = [...sourceFiles(serverRoot), ...sourceFiles(webRoot), ...sourceFiles(contractsRoot)];
const allFiles = new Set(files);
const graph = new Map();
const infrastructure = new Set(["execution-context.ts", "project-error.ts", "project-files.ts", "manual-sandbox.ts", "workspace-db.ts", "workspace-schema.ts"]);
const application = new Set(["server.ts", "tasks.ts", "chat-requests.ts", "manual-projects.ts", "project-pipeline.ts", "releases.ts", "contests.ts", "chat.ts"]);

for (const path of files) {
	const dependencies = [];
	for (const { specifier, typeOnly } of imports(path)) {
		const local = specifier.startsWith(".") ? resolve(dirname(path), specifier) : undefined;
		if (path.startsWith(contractsRoot) && (!local || !local.startsWith(`${contractsRoot}/`))) {
			failures.push(`${relative(root, path)}: contracts must remain independent (${specifier})`);
		}
		if (path.startsWith(webRoot) && (specifier.startsWith("node:") || specifier.startsWith("@setdraft/server") || specifier.startsWith("@earendil-works/pi-ai") || local?.startsWith(serverRoot))) {
			failures.push(`${relative(root, path)}: browser code must use shared contracts (${specifier})`);
		}
		if (typeOnly || !local) continue;
		if (path.startsWith(serverRoot) && infrastructure.has(basename(path)) && application.has(basename(local))) {
			failures.push(`${relative(root, path)}: infrastructure cannot depend on application modules (${specifier})`);
		}
		if (allFiles.has(local)) dependencies.push(local);
	}
	graph.set(path, dependencies);
}

const visiting = new Set();
const visited = new Set();
function walk(path, chain) {
	if (visiting.has(path)) {
		failures.push(`Runtime import cycle: ${[...chain.slice(chain.indexOf(path)), path].map((item) => relative(root, item)).join(" -> ")}`);
		return;
	}
	if (visited.has(path)) return;
	visiting.add(path);
	for (const dependency of graph.get(path) ?? []) walk(dependency, [...chain, path]);
	visiting.delete(path);
	visited.add(path);
}
for (const path of files) walk(path, []);

if (failures.length) {
	for (const failure of failures) console.error(failure);
	process.exitCode = 1;
} else console.log("Hydro module boundaries and runtime import cycles checked.");
