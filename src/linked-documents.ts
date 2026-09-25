// Click-to-open snapshots, not another set of file watchers. Reloading a linked
// document reads it again; its images and nested links use that file's directory.
// The bounded, text-only read is pi-markdown-preview's, so both tools apply the
// same checks.
import { dirname } from "node:path";
import { prepareFilePreview, renderPreviewHtmlDocument, type PreviewStyle } from "./render.js";
import { readLinkedDocument } from "./shared/read-linked-document.js";

export function localDocumentRenderer(style: PreviewStyle, fontSizePx: number, finish: (html: string) => string) {
	return async (path: string, signal: AbortSignal): Promise<string> => {
		const content = await readLinkedDocument(path, signal);
		signal.throwIfAborted();
		const prepared = prepareFilePreview(path, content);
		return finish((await renderPreviewHtmlDocument(prepared.markdown, style, dirname(path), prepared.isLatex, fontSizePx, signal)).html);
	};
}
