import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const docs = new URL("../docs/", import.meta.url);
const html = readFileSync(new URL("index.html", docs), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the landing page uses an opt-in native video player and a text alternative", () => {
	const player = html.match(/<video\b([^>]*)>/)?.[1];
	assert.ok(player);
	assert.match(player, /\bcontrols\b/);
	assert.match(player, /\bplaysinline\b/);
	assert.match(player, /preload="metadata"/);
	assert.doesNotMatch(player, /\b(?:autoplay|loop)\b/);
	assert.match(html, /<details>[\s\S]*Details of the demo/);
	assert.match(html, /automated typing/);
	assert.match(html, /redacted for this recording/);
	assert.match(html, /name="viewport"/);
	assert.ok(existsSync(new URL(".nojekyll", docs)));
});

test("local assets and section links exist; canonical and documentation links are correct", () => {
	for (const [, target] of html.matchAll(/(?:href|src|poster)="([^"]+)"/g)) {
		if (target.startsWith("#")) {
			assert.ok(html.includes('id="' + target.slice(1) + '"'), target);
		} else if (!/^[a-z][\w+.-]*:/i.test(target)) {
			assert.ok(existsSync(new URL(target, docs)), target);
		}
	}
	assert.ok(html.includes('rel="canonical" href="https://omaclaren.github.io/' + pkg.name + '/"'));
	assert.ok(html.includes("https://github.com/omaclaren/" + pkg.name + "#readme"));
	assert.doesNotMatch(html, /<script\b|<iframe\b|fonts\.googleapis|\/Users\/|\/home\/|<\/?cwd>|\/private\/tmp\/|127\.0\.0\.1|localhost|\?token=/i);
});

test("the public asset list is limited to the reviewed recording, poster and example code", () => {
	assert.deepEqual(readdirSync(new URL("assets/", docs)).sort(), ["demo-poster.png", "science.py", "shared-repl-demo.mp4"]);
	const video = readFileSync(new URL("assets/shared-repl-demo.mp4", docs));
	// Updating the recording requires deliberately reviewing and updating this checksum.
	assert.equal(createHash("sha256").update(video).digest("hex"), "fcc85b1fd1ade143dffe5cf7438725997b9c6282b27ffd3442e0ea468a6e1d31");
	assert.equal(video.length, 1588423);
	const code = readFileSync(new URL("assets/science.py", docs), "utf8");
	assert.match(code, /def lorenz\(p, t\):/);
	assert.match(code, /np\.linalg\.norm\(a - b, axis=1\)/);
	assert.doesNotMatch(code, /\/Users\/|<\/?cwd>|\?token=/i);
});
