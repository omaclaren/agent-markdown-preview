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

test("the public asset list is limited to reviewed screenshots, recording, poster and example code", () => {
	assert.deepEqual(readdirSync(new URL("assets/", docs)).sort(), ["all-projects.png", "demo-poster.png", "index.png", "live.png", "preview-light.png", "science.py", "shared-repl-demo.mp4"]);
	const video = readFileSync(new URL("assets/shared-repl-demo.mp4", docs));
	// Updating the recording requires deliberately reviewing and updating this checksum.
	assert.equal(createHash("sha256").update(video).digest("hex"), "fcc85b1fd1ade143dffe5cf7438725997b9c6282b27ffd3442e0ea468a6e1d31");
	assert.equal(video.length, 1588423);
	const code = readFileSync(new URL("assets/science.py", docs), "utf8");
	assert.match(code, /def lorenz\(p, t\):/);
	assert.match(code, /np\.linalg\.norm\(a - b, axis=1\)/);
	assert.doesNotMatch(code, /\/Users\/|<\/?cwd>|\?token=/i);
});

test("the main illustrations and setup precede the optional REPL demo", () => {
	const examples = html.indexOf('<section id="examples"');
	const setup = html.indexOf('<section id="setup"');
	const demo = html.indexOf('<section id="demo"');
	assert.ok(examples > 0 && examples < setup && setup < demo);
	const illustrations = html.slice(examples, setup);
	assert.match(illustrations, /src="assets\/preview-light\.png"/);
	assert.match(illustrations, /src="assets\/live\.png"/);
	assert.match(illustrations, /synthetic sessions/);
	assert.doesNotMatch(illustrations, /<video\b|--repl/);
	const demoIntroduction = html.slice(demo, html.indexOf("<video", demo));
	assert.match(demoIntroduction, /Optional shared REPL demo/);
	assert.match(demoIntroduction, /agent-markdown-preview --repl/);
	assert.match(html, /property="og:image" content="https:\/\/omaclaren\.github\.io\/agent-markdown-preview\/assets\/preview-light\.png"/);
	for (const [name, checksum] of Object.entries({
		"index.png": "8f8b8dc8292994ec913fe62fa1ca75826b00adc2d2fa8ed292d1ca858f4a09fe",
		"all-projects.png": "58c1f1f20c40c2b2549fc4c4affa860b7e54be965caec639d8fb7b06266822a2",
		"preview-light.png": "733df8c2cf1bb465b79d72674e3d94567a463a7cd695972a22e9d19d316ea90b",
		"live.png": "bb66c72453394cdf634bdbf9a5e2776ca225a3894c7f371d1fdfe74519eb14cb",
	})) {
		assert.equal(createHash("sha256").update(readFileSync(new URL("assets/" + name, docs))).digest("hex"), checksum);
	}
});

test("the page explains directory and cross-project session overviews before response previews", () => {
	const examples = html.slice(html.indexOf('<section id="examples"'), html.indexOf('<section id="setup"'));
	const directory = examples.indexOf("Sessions in the current directory");
	const across = examples.indexOf("Sessions across directories");
	const responses = examples.indexOf("Rendered responses");
	assert.ok(directory >= 0 && directory < across && across < responses);
	assert.match(examples.slice(directory, across), /<code>agent-markdown-preview<\/code>/);
	assert.match(examples.slice(directory, across), /All sessions \(merged\)/);
	assert.match(examples.slice(directory, across), /last three days, up to eight per agent/);
	assert.match(examples.slice(across, responses), /<code>agent-markdown-preview --all<\/code>/);
	assert.match(examples.slice(across, responses), /grouped by directory/);
	assert.match(examples.slice(across, responses), /Each directory has its own merged preview/);
	assert.match(examples.slice(across, responses), /up to 64 sessions in total/);
	assert.match(examples.slice(directory, across), /src="assets\/index\.png"/);
	assert.match(examples.slice(across, responses), /src="assets\/all-projects\.png"/);
});

test("live-mode guidance explains both view transitions and links Pi Studio", () => {
	const liveGuidance = html.match(/<h2>Following a turn<\/h2>\s*<p>([\s\S]*?)<\/p>/)?.[1];
	assert.ok(liveGuidance);
	assert.match(liveGuidance, /--live/);
	assert.match(liveGuidance, /Follow activity enabled/);
	assert.match(liveGuidance, /Preview[\s\S]*Working[\s\S]*Preview/);
	assert.match(html, /href="https:\/\/github\.com\/omaclaren\/pi-studio">Pi Studio<\/a>/);
});
