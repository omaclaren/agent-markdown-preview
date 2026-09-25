import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserWatchServer } from "../dist/shared/browser-watch-server.js";
import { startSessionIndex, styleForMode } from "../dist/watch.js";

const within = async (promise, label, timeoutMs = 5000) => {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
		})]);
	} finally { clearTimeout(timer); }
};
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), "amp-shutdown-")));
const html = body => `<!doctype html><html><head></head><body>${body}</body></html>`;

test("watch shutdown cancels linked renders, settles HTTP requests and releases its port", { timeout: 20_000 }, async () => {
	const root = fixture();
	const requests = new AbortController();
	let server, reopened, waiting = [], renders = 0, cancelled = 0;
	try {
		for (let i = 0; i < 5; i++) writeFileSync(join(root, `${i}.md`), `# ${i}`);
		server = await createBrowserWatchServer(html(Array.from({ length: 5 }, (_, i) => `<a href="${i}.md">${i}</a>`).join("")), root, {
			renderLocalDocument: (_path, signal) => {
				renders++;
				return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled++; reject(signal.reason); }, { once: true }));
			},
		});
		const first = await fetch(server.url);
		const headers = { cookie: first.headers.get("set-cookie").split(";")[0] };
		const body = await first.text();
		const urls = [...body.matchAll(/href="(\/__pi_markdown_preview_document__\/[^"#]+)"/g)].map(match => new URL(match[1], server.url));
		assert.equal(urls.length, 5);
		waiting = [0, 1, 2, 3, 0].map(i => fetch(urls[i], { headers, signal: requests.signal }).then(response => response.text()).catch(() => "closed"));
		const deadline = Date.now() + 5000;
		while (renders < 4 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
		assert.equal(renders, 4, "duplicate opens share a render");
		const limited = await fetch(urls[4], { headers });
		assert.equal(limited.status, 503);
		await limited.text();
		await within(server.close(), "watch shutdown with linked requests in flight");
		await within(Promise.all(waiting), "settling cancelled HTTP requests");
		assert.equal(cancelled, 4);
		await within(server.close(), "repeated watch shutdown");
		reopened = await createBrowserWatchServer(html("reopened"), root, { port: Number(new URL(server.url).port) });
		assert.match(await (await fetch(reopened.url)).text(), /reopened/);
	} finally {
		requests.abort();
		await within(Promise.all(waiting), "request cleanup");
		await within(server?.close(), "watch cleanup");
		await within(reopened?.close(), "reopened watch cleanup");
		rmSync(root, { recursive: true, force: true });
	}
});

test("index shutdown closes an unfinished HTTP request and supports an immediate restart", { timeout: 20_000 }, async () => {
	const root = fixture();
	const options = {
		cwd: root, roots: { claude: join(root, "claude"), codex: join(root, "codex"), pi: join(root, "pi") },
		style: styleForMode("light"), stateDir: join(root, "state"),
	};
	let index, reopened, socket;
	try {
		index = await startSessionIndex(options);
		const url = new URL(index.url);
		socket = connect({ host: "127.0.0.1", port: Number(url.port) });
		socket.on("error", () => {}); // A forced shutdown may reset the connection.
		socket.resume();
		const disconnected = new Promise(done => socket.once("close", done));
		await within(once(socket, "connect"), "connecting the unfinished request");
		// No terminating blank line: the server must not wait for this client to finish.
		await within(new Promise((done, fail) => socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n`, error => error ? fail(error) : done())), "writing partial headers");
		assert.match(await (await fetch(index.url)).text(), /Agent sessions/);
		assert.equal(socket.destroyed, false, "the incomplete request is still open before shutdown");
		await within(index.close(), "index shutdown");
		await within(disconnected, "closing the unfinished HTTP connection", 2000);
		await within(index.close(), "repeated index shutdown");
		reopened = await startSessionIndex(options);
		assert.equal(reopened.url, index.url, "the remembered address can be rebound immediately");
		assert.match(await (await fetch(reopened.url)).text(), /Agent sessions/);
	} finally {
		socket?.destroy();
		await within(index?.close(), "index cleanup");
		await within(reopened?.close(), "reopened index cleanup");
		rmSync(root, { recursive: true, force: true });
	}
});
