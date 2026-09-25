// Pi theme files (vars + colour roles + optional export backgrounds), resolved
// exactly as Pi does in a true-colour terminal, so the renderer produces the
// same palette as pi-markdown-preview inside Pi.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPreviewStyle, type PreviewStyle, type PreviewTheme } from "./render.js";

/** Themes bundled with this package (copied from pi-studio). */
export const BUNDLED_THEMES: Record<string, string> = {
	"pi-studio-light": fileURLToPath(new URL("./themes/pi-studio-light.json", import.meta.url)),
	"pi-studio-dark": fileURLToPath(new URL("./themes/pi-studio-dark.json", import.meta.url)),
};

type ThemeColor = string | number;
// Pi's background roles; every other role is a foreground colour.
const BACKGROUND_ROLES = new Set(["selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);

function resolveVar(value: ThemeColor, vars: Record<string, ThemeColor>, seen = new Set<string>()): ThemeColor {
	if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
	if (seen.has(value)) throw new Error(`Circular variable reference in theme: ${value}`);
	if (!(value in vars)) throw new Error(`Theme variable not found: ${value}`);
	seen.add(value);
	return resolveVar(vars[value]!, vars, seen);
}

function toAnsi(color: ThemeColor, layer: 38 | 48): string {
	if (color === "") return layer === 38 ? "\x1b[39m" : "\x1b[49m";
	if (typeof color === "number") return `\x1b[${layer};5;${color}m`;
	const hex = color.replace("#", "");
	const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
	if (hex.length !== 6 || [r, g, b].some(Number.isNaN)) throw new Error(`Invalid hex colour in theme: ${color}`);
	return `\x1b[${layer};2;${r};${g};${b}m`;
}

/** Loads a Pi theme file as the structural theme the renderer accepts. */
export function loadPiTheme(path: string): PreviewTheme {
	const json = JSON.parse(readFileSync(path, "utf8"));
	if (!json || typeof json !== "object" || !json.colors || typeof json.colors !== "object") throw new Error(`${path} is not a Pi theme file.`);
	const colors = json.colors as Record<string, ThemeColor>;
	const withFallbacks: Record<string, ThemeColor | undefined> = {
		...colors,
		scrollbarTrack: colors.scrollbarTrack ?? colors.muted,
		scrollbarThumb: colors.scrollbarThumb ?? colors.text,
		thinkingMax: colors.thinkingMax ?? colors.thinkingXhigh,
		searchMatchBg: colors.searchMatchBg ?? colors.selectedBg,
		searchMatchText: colors.searchMatchText ?? colors.text,
	};
	const foreground = new Map<string, string>(), background = new Map<string, string>();
	for (const [role, value] of Object.entries(withFallbacks)) {
		if (value === undefined) continue;
		const resolved = resolveVar(value, json.vars ?? {});
		if (BACKGROUND_ROLES.has(role)) background.set(role, toAnsi(resolved, 48));
		else foreground.set(role, toAnsi(resolved, 38));
	}
	return {
		name: typeof json.name === "string" ? json.name : undefined,
		sourcePath: path,
		getFgAnsi(role: string) {
			const ansi = foreground.get(role);
			if (!ansi) throw new Error(`Unknown theme color: ${role}`);
			return ansi;
		},
		getBgAnsi(role: string) {
			const ansi = background.get(role);
			if (!ansi) throw new Error(`Unknown theme background color: ${role}`);
			return ansi;
		},
	};
}

/** The preview style for a bundled theme name or a Pi theme file path. */
export function styleForPiTheme(nameOrPath: string): PreviewStyle {
	return getPreviewStyle(loadPiTheme(BUNDLED_THEMES[nameOrPath] ?? nameOrPath));
}
