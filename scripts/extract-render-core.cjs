#!/usr/bin/env node
// Regenerates src/render.ts from pi-markdown-preview's index.ts.
//
// The renderer is copied, not rewritten: this script takes the transitive
// closure of top-level declarations reachable from ROOTS and emits them verbatim
// in their original order. The only substitution is Pi's `Theme` type, replaced
// by a structural PreviewTheme (Pi's Theme still satisfies it).
//
// Usage: node scripts/extract-render-core.cjs ../pi-markdown-preview
// Then copy that repo's client/ and shared/ into src/ and run the tests.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOTS = [
	"renderPreviewHtmlDocument", "getPreviewStyle", "buildBrowserHtmlFromPandocFragment", "prepareFilePreview",
	"normalizePreviewFontSizePx", "DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX", "RENDER_VERSION", "PreviewStyle",
	"DARK_PREVIEW_PALETTE", "LIGHT_PREVIEW_PALETTE", "extractAssistantMarkdownContent",
];
const EXPORTS = [...ROOTS, "ThemeMode", "PreviewPalette", "PreparedFilePreview"];
const TYPE_EXPORTS = new Set(["PreviewStyle", "ThemeMode", "PreviewPalette", "PreparedFilePreview"]);
const PI_MODULES = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);

const sourceRepo = path.resolve(process.argv[2] ?? "../pi-markdown-preview");
const sourceFile = path.join(sourceRepo, "index.ts");
const text = fs.readFileSync(sourceFile, "utf8");
const sf = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const declarations = [];
const importOf = new Map(); // local name -> { statement, element }
for (const [index, statement] of sf.statements.entries()) {
	if (ts.isImportDeclaration(statement)) {
		const clause = statement.importClause;
		if (!clause) continue;
		if (clause.name) importOf.set(clause.name.text, { statement, kind: "default" });
		if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) importOf.set(clause.namedBindings.name.text, { statement, kind: "namespace" });
		else clause.namedBindings?.elements.forEach(element => importOf.set(element.name.text, { statement, kind: "named", element }));
		continue;
	}
	let names = [];
	if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
		|| ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names = [statement.name.text];
	else if (ts.isVariableStatement(statement)) {
		for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
	}
	if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) names = [];
	const refs = new Set();
	const walk = node => { if (ts.isIdentifier(node)) refs.add(node.text); ts.forEachChild(node, walk); };
	ts.forEachChild(statement, walk);
	declarations.push({ index, names, statement, refs });
}
const byName = new Map();
for (const declaration of declarations) for (const name of declaration.names) byName.set(name, declaration);

const kept = new Set(), usedImports = new Set();
const stack = ROOTS.map(root => {
	const declaration = byName.get(root);
	if (!declaration) throw new Error(`Root ${root} not found in ${sourceFile}`);
	return declaration;
});
while (stack.length) {
	const declaration = stack.pop();
	if (kept.has(declaration)) continue;
	kept.add(declaration);
	for (const ref of declaration.refs) {
		const next = byName.get(ref);
		if (next && !kept.has(next)) stack.push(next);
		if (importOf.has(ref)) usedImports.add(ref);
	}
}

// Rebuild import statements with only the used bindings, preserving aliases.
const importsByModule = new Map();
for (const name of usedImports) {
	const { statement, kind, element } = importOf.get(name);
	const moduleName = statement.moduleSpecifier.text;
	if (PI_MODULES.has(moduleName)) {
		if (name !== "Theme") throw new Error(`Render core would depend on Pi runtime export ${name}`);
		continue;
	}
	if (!importsByModule.has(moduleName)) importsByModule.set(moduleName, { typeOnly: Boolean(statement.importClause.isTypeOnly), defaults: [], namespaces: [], named: [] });
	const entry = importsByModule.get(moduleName);
	if (kind === "default") entry.defaults.push(name);
	else if (kind === "namespace") entry.namespaces.push(name);
	else entry.named.push((element.isTypeOnly ? "type " : "") + (element.propertyName ? `${element.propertyName.text} as ${name}` : name));
}
const importLines = [...importsByModule].map(([moduleName, entry]) => {
	const parts = [...entry.defaults, ...entry.namespaces.map(n => `* as ${n}`)];
	if (entry.named.length) parts.push(`{ ${entry.named.sort().join(", ")} }`);
	return `import ${entry.typeOnly ? "type " : ""}${parts.join(", ")} from "${moduleName}";`;
});

let commit = "unknown";
try { commit = execFileSync("git", ["-C", sourceRepo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
let version = "unknown";
try { version = JSON.parse(fs.readFileSync(path.join(sourceRepo, "package.json"), "utf8")).version; } catch {}

const body = [...kept].sort((a, b) => a.index - b.index).map(d => text.slice(d.statement.getFullStart(), d.statement.getEnd())).join("");
const output = `// GENERATED by scripts/extract-render-core.cjs from pi-markdown-preview ${version} (${commit}).
// Do not edit by hand: change pi-markdown-preview and regenerate, so the two
// renderers stay identical until pi-markdown-preview depends on this package.
// @ts-nocheck is deliberately absent: this file is typechecked like the original.
${importLines.join("\n")}

/** Structural subset of Pi's Theme used by the renderer. Pi's Theme satisfies it. */
export interface PreviewTheme {
	readonly name?: string;
	readonly sourcePath?: string;
	getFgAnsi(color: any): string;
	getBgAnsi(color: any): string;
}
type Theme = PreviewTheme;
${body}

export { ${EXPORTS.filter(name => !TYPE_EXPORTS.has(name)).join(", ")} };
export type { ${EXPORTS.filter(name => TYPE_EXPORTS.has(name)).join(", ")} };
`;
const target = path.join(__dirname, "..", "src", "render.ts");
fs.writeFileSync(target, output);
console.log(`Wrote ${path.relative(process.cwd(), target)}: ${kept.size} declarations, ${output.length} characters, from pi-markdown-preview ${version} (${commit}).`);
