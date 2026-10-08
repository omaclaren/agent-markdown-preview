// Preview-owned palettes, not a reading of another agent's terminal settings.
// Layout, typography and the renderer remain shared across all presets.
import type { PreviewStyle, ThemeMode } from "./render.js";
import { styleForMode } from "./theme.js";
import { styleForPiTheme } from "./pi-theme.js";
import { AGENTS, type AgentKind } from "./sessions.js";

export type Appearance = "system" | "light" | "dark";
export interface PageTheme { style: PreviewStyle; darkStyle?: PreviewStyle; followSystemTheme: boolean }
export interface ThemeSelection extends PageTheme { agentThemes?: Record<AgentKind, PageTheme> }
export const PRESETS = ["neutral", "claude", "codex", "opencode", "pi", "pi-studio"] as const;
type Preset = typeof PRESETS[number];
type Surface = { bg: string; card: string; panel2: string; border: string; text: string; muted: string; accent: string };
const SURFACES: Record<"neutral" | "claude" | "codex" | "opencode", Record<ThemeMode, Surface>> = {
 neutral: {
  light: { bg: "#f7f6f3", card: "#ffffff", panel2: "#f0eee8", border: "#dedbd3", text: "#1d1d1b", muted: "#64635e", accent: "#2f5fd0" },
  dark: { bg: "#161615", card: "#1f1f1d", panel2: "#2a2926", border: "#34332f", text: "#ecebe6", muted: "#aaa89f", accent: "#8baaff" },
 },
 claude: {
  light: { bg: "#f7f5ef", card: "#fffdf8", panel2: "#efebe2", border: "#ddd6c9", text: "#302b25", muted: "#6a6258", accent: "#97472e" },
  dark: { bg: "#1c1916", card: "#25211d", panel2: "#302a24", border: "#463b32", text: "#eee7dc", muted: "#b4a799", accent: "#e5a17f" },
 },
 codex: {
  light: { bg: "#f5f7f6", card: "#ffffff", panel2: "#edf2ef", border: "#d7dfdb", text: "#202723", muted: "#58665e", accent: "#086c53" },
  dark: { bg: "#151917", card: "#1d2420", panel2: "#26302a", border: "#35463c", text: "#e7eee9", muted: "#a3b5aa", accent: "#78ceb0" },
 },
 opencode: {
  light: { bg: "#f4f6fa", card: "#ffffff", panel2: "#eaf0f8", border: "#d4dce8", text: "#222b3b", muted: "#55647a", accent: "#3657b7" },
  dark: { bg: "#151922", card: "#1d2430", panel2: "#283244", border: "#3a4961", text: "#e6edf8", muted: "#a7b5cc", accent: "#92b4ff" },
 },
};

export function styleForPreset(name: Preset, mode: ThemeMode): PreviewStyle {
 if (name === "pi") return styleForPiTheme(`pi-${mode}`);
 if (name === "pi-studio") return styleForPiTheme(`pi-studio-${mode}`);
 const surface = SURFACES[name][mode];
 const palette = { ...styleForMode(mode).palette, ...surface,
  borderMuted: surface.border, codeBg: surface.panel2, link: surface.accent,
  mdHeading: surface.text, mdLink: surface.accent, mdLinkUrl: surface.muted,
  mdCode: surface.accent, mdCodeBlock: surface.text, mdCodeBlockBorder: surface.border,
  mdQuote: surface.muted, mdQuoteBorder: surface.border, mdHr: surface.border, mdListBullet: surface.accent,
 };
 return { themeMode: mode, palette, cacheKey: [mode, ...Object.values(palette)].join("|") };
}

function pair(name: Preset | "legacy", appearance: Appearance): PageTheme {
 const style = (mode: ThemeMode) => name === "legacy" ? styleForMode(mode) : styleForPreset(name, mode);
 return appearance === "system"
  ? { style: style("light"), darkStyle: style("dark"), followSystemTheme: true }
  : { style: style(appearance), followSystemTheme: false };
}

export function parseAgentTheme(value: string): [AgentKind, string] {
 const separator = value.indexOf("=");
 const agent = value.slice(0, separator), theme = value.slice(separator + 1);
 if (separator < 1 || !(AGENTS as readonly string[]).includes(agent) || !theme.trim() || theme === "agent") {
  throw new Error("--agent-theme needs agent=theme, e.g. pi=pi-studio (claude, codex, pi or opencode; no recursive agent theme).");
 }
 return [agent as AgentKind, theme];
}

/** Legacy names keep their defaults; an explicit appearance overrides paired names. */
export function resolveTheme(name = "agent", appearance?: Appearance, overrides: Partial<Record<AgentKind, string>> = {}): ThemeSelection {
 if (appearance !== undefined && !["system", "light", "dark"].includes(appearance)) throw new Error("--appearance must be system, light or dark.");
 if (Object.keys(overrides).length && name !== "agent") throw new Error("--agent-theme requires --theme agent (the default); it cannot be combined with a global palette.");
 for (const [agent, theme] of Object.entries(overrides)) {
  if (typeof theme !== "string") throw new Error("--agent-theme needs a theme name or file.");
  parseAgentTheme(`${agent}=${theme}`);
 }
 if (name.endsWith(".json")) {
  const style = styleForPiTheme(name);
  if (appearance && appearance !== style.themeMode) throw new Error(`A single Pi theme file is fixed ${style.themeMode}; use a paired preset for ${appearance} appearance.`);
  return { style, followSystemTheme: false };
 }
 if (name === "agent") {
  const mode = appearance ?? "system";
  return { ...pair("neutral", mode), agentThemes: Object.fromEntries(AGENTS.map(agent => [agent, Object.hasOwn(overrides, agent) ? resolveTheme(overrides[agent]!, appearance) : pair(agent, mode)])) as Record<AgentKind, PageTheme> };
 }
 if (name === "auto" || name === "light" || name === "dark") return pair("legacy", appearance ?? (name === "auto" ? "system" : name));
 const match = /^(neutral|claude|codex|opencode|pi|pi-studio)(?:-(light|dark))?$/.exec(name);
 if (match) return pair(match[1] as Preset, appearance ?? (match[2] as ThemeMode | undefined) ?? "system");
 throw new Error(`Unknown theme "${name}". Use auto, agent, ${PRESETS.join(", ")}, a light/dark variant, or a Pi theme .json file.`);
}
