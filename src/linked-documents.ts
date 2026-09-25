// Click-to-open snapshots, not another set of file watchers. Reloading a linked
// document reads it again; its images and nested links use that file's directory.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { prepareFilePreview, renderPreviewHtmlDocument, type PreviewStyle } from "./render.js";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const unsupported = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export function localDocumentRenderer(style: PreviewStyle, fontSizePx: number, finish: (html: string) => string) {
	return async (path: string, signal: AbortSignal): Promise<string> => {
		signal.throwIfAborted();
		// O_NONBLOCK avoids waiting on a FIFO if a path changes before open().
		const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		let content: string;
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw unsupported("Only regular text/code files can be previewed.", 415);
			if (info.size > MAX_DOCUMENT_BYTES) throw unsupported("Linked document is too large (limit: 2 MiB).", 413);
			// Bound the actual read too, including files growing while we read them.
			const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				signal.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
				if (!bytesRead) break;
				size += bytesRead;
			}
			if (size > MAX_DOCUMENT_BYTES) throw unsupported("Linked document is too large (limit: 2 MiB).", 413);
			const bytes = buffer.subarray(0, size);
			if (bytes.includes(0)) throw unsupported("Linked document is binary, not UTF-8 text.", 415);
			try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
			catch { throw unsupported("Linked document must be UTF-8 text.", 415); }
		} finally { await handle.close(); }
		signal.throwIfAborted();
		const prepared = prepareFilePreview(path, content);
		return finish((await renderPreviewHtmlDocument(prepared.markdown, style, dirname(path), prepared.isLatex, fontSizePx, signal)).html);
	};
}
