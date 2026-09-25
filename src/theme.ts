// Light/dark handling. The renderer produces a page for one palette; pages for
// two palettes differ only in the `:root` colour variables and the Mermaid
// configuration (checked by test/theme.test.mjs). An adaptive page therefore
// keeps the light palette's variables, adds the dark palette's under a
// prefers-color-scheme rule, and lets Mermaid choose its configuration by the
// current scheme. The two palettes form a pair: the built-in light and dark
// palettes by default, or e.g. pi-studio light and dark.
import { buildBrowserHtmlFromPandocFragment, DARK_PREVIEW_PALETTE, LIGHT_PREVIEW_PALETTE, type PreviewStyle, type ThemeMode } from "./render.js";

/** Same result as pi-markdown-preview's getPreviewStyle() without a Pi theme. */
export function styleForMode(mode: ThemeMode): PreviewStyle {
	const palette = mode === "dark" ? DARK_PREVIEW_PALETTE : LIGHT_PREVIEW_PALETTE;
	return { themeMode: mode, palette, cacheKey: [mode, ...Object.values(palette)].join("|") };
}

const ROOT_BLOCK = /<style>\n:root \{\n([\s\S]*?)\n\}/;
const MERMAID_CONFIG = /\{"startOnLoad":false,"theme":"base","themeVariables":\{[^{}]*\}\}/;
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeParts { vars: string; mermaid: string }
const partsCache = new Map<string, { light: ThemeParts; dark: ThemeParts }>();
const DEFAULT_LIGHT = styleForMode("light"), DEFAULT_DARK = styleForMode("dark");

function partsOf(html: string): ThemeParts | null {
	const vars = html.match(ROOT_BLOCK)?.[1];
	const mermaid = html.match(MERMAID_CONFIG)?.[0];
	return vars && mermaid ? { vars, mermaid } : null;
}

function referenceParts(fontSizePx: number, lightStyle: PreviewStyle, darkStyle: PreviewStyle) {
	const key = `${fontSizePx}\0${lightStyle.cacheKey}\0${darkStyle.cacheKey}`;
	let parts = partsCache.get(key);
	if (!parts) {
		const light = partsOf(buildBrowserHtmlFromPandocFragment("", lightStyle, undefined, [], fontSizePx));
		const dark = partsOf(buildBrowserHtmlFromPandocFragment("", darkStyle, undefined, [], fontSizePx));
		if (!light || !dark) throw new Error("The renderer's page structure changed; light/dark switching needs updating.");
		parts = { light, dark };
		partsCache.set(key, parts);
	}
	return parts;
}

/**
 * Turns a page rendered with `lightStyle` into one that follows the system
 * light/dark setting live, using `darkStyle` for dark. Returns null if the page
 * is not in the expected shape (callers keep the light page).
 */
export function makeThemeAdaptive(html: string, fontSizePx: number, lightStyle = DEFAULT_LIGHT, darkStyle = DEFAULT_DARK): string | null {
	const { light, dark } = referenceParts(fontSizePx, lightStyle, darkStyle);
	const page = partsOf(html);
	if (!page || page.vars !== light.vars || page.mermaid !== light.mermaid) return null;
	const reloadOnSwitch = `<script>
(() => {
  // Colours follow the system at once; Mermaid diagrams are drawn with fixed
  // colours, so redraw them by reloading when the scheme changes.
  const query = window.matchMedia?.(${JSON.stringify(DARK_QUERY)});
  query?.addEventListener('change', () => { if (document.querySelector('.mermaid-container, .mermaid')) location.reload(); });
})();
</script>`;
	return html
		.replace(ROOT_BLOCK, () => `<style>\n:root {\n${light.vars}\n}\n@media ${DARK_QUERY} {\n:root {\n${dark.vars}\n}\n}`)
		.replace(MERMAID_CONFIG, () => `(window.matchMedia?.(${JSON.stringify(DARK_QUERY)}).matches ? ${dark.mermaid} : ${light.mermaid})`)
		.replace(/<\/head>/i, () => `<meta name="color-scheme" content="light dark" />\n${reloadOnSwitch}\n</head>`);
}

/** A page finisher for a theme choice: fixed pages pass through unchanged. */
export function themeFinisher(followSystem: boolean, fontSizePx: number, log: (message: string) => void, lightStyle = DEFAULT_LIGHT, darkStyle = DEFAULT_DARK): (html: string) => string {
	if (!followSystem) return html => html;
	let warned = false;
	return html => {
		const adaptive = makeThemeAdaptive(html, fontSizePx, lightStyle, darkStyle);
		if (adaptive) return adaptive;
		if (!warned) { warned = true; log("Could not make a page follow the system light/dark setting; showing it light."); }
		return html;
	};
}
