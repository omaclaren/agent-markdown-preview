import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { agyMetadataCwd, agyTranscriptPath, createAgyMediaBudget, protobufStrings, readAgyTurnDetails, withAgyMedia } from "../dist/agy.js";
import { createLiveLeases, createLiveSource } from "../dist/watch.js";
import { resolveTheme } from "../dist/appearance.js";
import { createResponseReader, createSessionFinder, createSessionReader, detectAgent, modelLabel, sessionShortId } from "../dist/sessions.js";
import { createSessionMonitor } from "../dist/monitor.js";
import { createLiveTurnProjector, turnDetailsFromRecords } from "../dist/shared/turn-details.js";

const sqliteModule = process.versions.bun ? "bun:sqlite" : "node:sqlite";
const { DatabaseSync: NodeDatabase, Database: BunDatabase } = await import(sqliteModule);
const Database = NodeDatabase ?? BunDatabase;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
	for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await sleep(20); }
	throw new Error("Timed out waiting for " + label);
}

// Steps shaped as agy 1.3 records them (transcript_full.jsonl), with synthetic text.
let step = 0;
const at = n => `2026-11-23T04:${String(10 + Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}Z`;
const agyStep = (type, source, fields = {}) => ({ step_index: step, source, type, status: "DONE", created_at: at(step++), ...fields });
const prompt = text => agyStep("USER_INPUT", "USER_EXPLICIT", { content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: SECRET-TIME.\n</ADDITIONAL_METADATA>` });
const notice = text => agyStep("SYSTEM_MESSAGE", "SYSTEM", { content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n${text}\n</SYSTEM_MESSAGE>` });
const model = (fields) => agyStep("PLANNER_RESPONSE", "MODEL", { model: "gemini-4-neon-high", ...fields });
const output = (text, status = "DONE") => agyStep("GENERIC", "MODEL", { status, content: `Created At: 2026-11-23T17:18:51+13:00\nCompleted At: 2026-11-23T17:18:52+13:00\n${text}` });
const runCommand = command => ({ name: "run_command", args: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Run it" } });

// The conversation's metadata blob: workspaces (1), creation time (2), trajectory (3),
// parent (5), root (6) and workspace URI (7), as agy 1.3 writes them.
const varint = n => { const out = []; do { const low = n % 128; n = Math.floor(n / 128); out.push(n ? low | 0x80 : low); } while (n); return out; };
const field = (number, bytes) => Buffer.from([...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]);
const text = (number, value) => field(number, Buffer.from(value));
const metadata = ({ cwd, id, parent }) => Buffer.concat([
	field(1, Buffer.concat([text(1, pathToFileURL(cwd).href), text(3, "")])), field(2, Buffer.from([0x08, 0x88, 0x01])),
	text(3, "6f0e1c2a-0000-4000-8000-000000000001"), ...(parent ? [text(5, parent)] : []), text(6, parent ?? id), text(7, pathToFileURL(cwd).href),
]);

function fixture(t) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "amp-agy-"))), root = join(base, "antigravity-cli"), cwd = join(base, "project");
	mkdirSync(join(root, "conversations"), { recursive: true }); mkdirSync(cwd);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const conversation = (id, { cwd: folder = cwd, parent, steps = [], blob } = {}) => {
		const path = agyTranscriptPath(root, id);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, steps.map(s => JSON.stringify(s) + "\n").join(""));
		const db = new Database(join(root, "conversations", `${id}.db`));
		db.exec("CREATE TABLE trajectory_metadata_blob (`id` text DEFAULT \"main\", `data` blob, PRIMARY KEY (`id`))");
		db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(blob ?? metadata({ cwd: folder, id, parent }));
		db.close();
		return path;
	};
	return { base, root, cwd, conversation, append: (path, ...steps) => appendFileSync(path, steps.map(s => JSON.stringify(s) + "\n").join("")) };
}

const ID = "03201f23-61b2-411c-8ce0-b0341ef022f0", SUB = "09e65e31-f16a-415f-a52a-52689985bea0";

test("agy: an answer is a finished model step with text and no tool calls; its key names the conversation", () => {
	step = 0;
	const path = `/home/me/.gemini/antigravity-cli/brain/${ID}/.system_generated/logs/transcript_full.jsonl`;
	const steps = [
		prompt("Read the notes"), notice("[Notice] SECRET-NOTICE"),
		model({ thinking: "Plan", tool_calls: [{ name: "read_file", args: { Path: "/p/notes.md" } }] }),
		output("1: # Notes"),
		model({ content: "Interim words", tool_calls: [runCommand("ls")] }),
		output("notes.md"),
		model({ status: "RUNNING", content: "Half an answer" }),
		model({ content: "   " }),
		model({ content: "**Done.**" }),
	];
	const read = createResponseReader("agy", path);
	const responses = steps.map(s => read(s)).filter(Boolean);
	assert.deepEqual(responses.map(r => [r.key, r.markdown, r.model, r.time]), [[`agy:${ID}:8`, "**Done.**", "gemini-4-neon-high", Date.parse(at(8))]]);
	assert.equal(modelLabel(responses[0].model), "Gemini 4 Neon High");
	assert.equal(createResponseReader("agy", path.replace(ID, SUB))(steps[8]).key, `agy:${SUB}:8`, "another conversation's step 8 is another answer");
	const events = createSessionReader("agy", path);
	assert.deepEqual(steps.flatMap(s => events(s)).map(e => e.kind === "title" ? `title:${e.title}` : e.kind === "working" ? `working:${e.working}` : `response:${e.response.key.split(":").at(-1)}`),
		["working:true", "title:Read the notes", "response:8", "working:false"]);
	assert.equal(sessionShortId(path), "22f0", "the conversation, not the file name");
	const resumed = createSessionReader("agy", path);
	const working = [prompt("Ask the helper"), model({ content: "Waiting for the helper." }), notice("[Message] sender=helper"), model({ tool_calls: [runCommand("ls")] }), output("a.md"), model({ content: "Done." })]
		.flatMap(s => resumed(s)).filter(e => e.kind === "working").map(e => e.working);
	assert.deepEqual(working, [true, false, true, false], "working again when agy wakes the model after an answer");
	assert.equal(createResponseReader("agy", "/p/transcript.jsonl")(model({ content: "Hi" })).key, `agy:/p/transcript.jsonl:${step - 1}`, "a path without a conversation names it");
});

test("agy discovery: conversations by the folder their metadata records; subagents and unreadable metadata are left out", async t => {
	step = 0;
	const f = fixture(t);
	const main = f.conversation(ID, { steps: [prompt("Hello"), model({ content: "Hi" })] });
	f.conversation(SUB, { parent: ID, steps: [prompt("Sub task"), model({ content: "sub ok" })] });
	f.conversation("11111111-2222-4333-8444-555555555555", { cwd: join(f.base, "elsewhere"), steps: [prompt("Elsewhere")] });
	const damaged = "22222222-2222-4333-8444-555555555555", empty = "44444444-2222-4333-8444-555555555555";
	f.conversation(damaged, { blob: Buffer.from([0xff, 0xff, 0xff]), steps: [prompt("Damaged")] });
	const pending = f.conversation(empty, { blob: Buffer.alloc(0), steps: [prompt("Metadata to come")] });
	const old = f.conversation("55555555-2222-4333-8444-555555555555", { steps: [prompt("Long ago")] });
	const longAgo = new Date(Date.now() - 46 * 24 * 60 * 60 * 1000);
	utimesSync(old, longAgo, longAgo);
	const orphan = agyTranscriptPath(f.root, "33333333-2222-4333-8444-555555555555");
	mkdirSync(join(orphan, ".."), { recursive: true }); writeFileSync(orphan, JSON.stringify(prompt("No database")) + "\n");
	mkdirSync(join(f.root, "brain", "not-a-conversation"), { recursive: true });
	const find = createSessionFinder({ agy: f.root });
	assert.deepEqual((await find("agy", f.cwd)).map(file => file.path), [main]);
	assert.deepEqual((await find.all("agy")).map(file => [file.path.split("/").at(-4).slice(0, 8), file.cwd]).sort(), [["03201f23", f.cwd], ["11111111", join(f.base, "elsewhere")]], "not one older than 45 days");
	// Metadata that couldn't be read is read again: it may be written later.
	for (const id of [damaged, empty]) {
		const db = new Database(join(f.root, "conversations", `${id}.db`));
		db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(metadata({ cwd: f.cwd, id }));
		db.close();
	}
	assert.deepEqual((await find("agy", f.cwd)).map(file => file.path).sort(), [main, agyTranscriptPath(f.root, damaged), pending].sort());
	assert.equal(await detectAgent(main), "agy", "by its first line");
	assert.equal(await detectAgent("/home/me/.gemini/antigravity-cli/brain/x/transcript_full.jsonl"), "agy", "by its path");
	// The metadata reader: a root conversation other than itself is a subagent too; a blob that isn't protobuf, nothing.
	assert.equal(agyMetadataCwd(metadata({ cwd: "/p", id: ID }), ID), "/p");
	assert.equal(agyMetadataCwd(metadata({ cwd: "/p", id: ID }), SUB), null);
	assert.equal(agyMetadataCwd(Buffer.concat([text(1, "not a message"), text(7, "https://example.com/p")]), ID), null);
	assert.equal(agyMetadataCwd(Buffer.from([0xff]), ID), undefined, "unreadable: not known yet");
	assert.equal(agyMetadataCwd(Buffer.concat([text(6, ID), text(7, "file:///p/q/")]), ID), "/p/q", "without a trailing slash");
	assert.equal(agyMetadataCwd(Buffer.concat([text(6, ID), text(7, "file:///")]), ID), "/");
	const nanoseconds = Buffer.from([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
	assert.equal(agyMetadataCwd(Buffer.concat([nanoseconds, text(6, ID), text(7, "file:///p")]), ID), "/p", "a 64-bit number is skipped");
	assert.equal(protobufStrings(Buffer.from([0x0a, 0x05, 0x61]), new Set([1])), null, "a length past the end");
	assert.equal(protobufStrings(Buffer.from([0x0b]), new Set([1])), null, "an unknown wire type");
	const many = Buffer.concat([Buffer.from(Array.from({ length: 100_000 }, () => [0x12, 0x00]).flat()), text(7, "a"), text(7, "b")]);
	assert.deepEqual([...protobufStrings(many, new Set([7]))].map(([n, v]) => [n, String(Buffer.from(v))]), [[7, "a"]], "only the first of each field it reads");
});

test("agy monitor: a conversation's answers arrive as it records them", async t => {
	step = 0;
	const f = fixture(t);
	const path = f.conversation(ID, { steps: [prompt("First"), model({ content: "History" })] });
	const monitor = createSessionMonitor({ cwd: f.cwd, roots: { agy: f.root }, agents: ["agy"], tailIntervalMs: 25, rescanMs: 60, stateDir: null });
	t.after(() => monitor.close());
	const responses = [];
	monitor.onResponse((session, response, fresh) => responses.push({ text: response.markdown, fresh, label: session.shortId }));
	await monitor.ready;
	assert.deepEqual(responses, [{ text: "History", fresh: false, label: "22f0" }]);
	f.append(path, prompt("Second"));
	await until(() => monitor.sessions()[0]?.working, "working");
	assert.equal(monitor.sessions()[0].title, "First");
	f.append(path, model({ content: "Checking", tool_calls: [runCommand("ls")] }), output("a.md"), model({ content: "Live answer" }));
	await until(() => responses.length === 2, "the live answer");
	assert.deepEqual(responses[1], { text: "Live answer", fresh: true, label: "22f0" });
	assert.equal(monitor.sessions()[0].working, false);
});

test("agy Working: a turn from its typed prompt to the answer, with tools, results and the latest record of each step", () => {
	step = 0;
	const path = `/x/brain/${ID}/.system_generated/logs/transcript_full.jsonl`;
	const records = [
		prompt("Earlier"), model({ content: "Earlier answer" }),
		prompt("Run the checks"), notice("SECRET-NOTICE"),
		model({ thinking: "Plan the run\n\n", content: "\nRunning them.\n", tool_calls: [runCommand("npm test"), { name: "read_file", args: { Path: "/p/log.txt" } }] }),
		output("Tool is running as a background task", "RUNNING"),
		output("log contents\n\n"),
		model({ content: "Waiting for a helper." }),
		notice("[Message] sender=helper content=SECRET-REPLY"),
		model({ content: "All green." }),
	];
	records.splice(7, 0, { ...records[5], status: "DONE", content: `${"Created At: 2026-11-23T22:02:53+13:00\nCompleted At: 2026-11-23T22:02:53+13:00\n".repeat(2)}12 tests passed` }); // agy can record its timing lines twice
	const read = createResponseReader("agy", path);
	const [earlier, waiting, final] = records.map(r => read(r)).filter(Boolean);
	assert.deepEqual([earlier.markdown, waiting.markdown, final.markdown], ["Earlier answer", "Waiting for a helper.", "All green."]);
	const details = turnDetailsFromRecords("agy", records, final);
	assert.deepEqual(details.events.map(e => [e.kind, e.label, e.text]), [
		["prompt", "Prompt / input", "Run the checks"],
		["reasoning", "Recorded thinking / reasoning", "Plan the run"],
		["progress", "Assistant progress", "Running them."],
		["tool", "Tool: run_command", JSON.stringify(runCommand("npm test").args, null, 2)],
		["tool", "Tool: read_file", JSON.stringify({ Path: "/p/log.txt" }, null, 2)],
		["result", "Tool result", "log contents"],
		["result", "Tool result", "12 tests passed"],
		["progress", "Assistant progress", "Waiting for a helper."],
	]);
	assert.equal(details.sourceAgent, "agy");
	assert.doesNotMatch(JSON.stringify(details), /SECRET/);
	assert.match(details.notices.join(" "), /harness-injected context is omitted/);
	assert.deepEqual(turnDetailsFromRecords("agy", records, waiting).events.at(-1).text, "12 tests passed", "an earlier answer's turn ends with it");
	assert.match(turnDetailsFromRecords("agy", records, { ...final, markdown: "Changed" }).notices.join(" "), /cannot be matched/);
	assert.match(turnDetailsFromRecords("agy", records.slice(4), final).notices.join(" "), /input prompt is not available/);
});

test("agy Working: a step recorded again belongs to its first turn; a step that could not be read after an answer starts the next turn", () => {
	step = 0;
	const path = `/x/brain/${ID}/.system_generated/logs/transcript_full.jsonl`;
	const records = [prompt("Start the server"), model({ tool_calls: [runCommand("serve")] })];
	const server = output("Tool is running as a background task", "RUNNING");
	records.push(server, model({ content: "Started." }), prompt("Check the logs"), model({ tool_calls: [runCommand("cat log")] }));
	records.push({ ...server, status: "DONE", content: "server stopped" }, output("Created At: yesterday"), model({ content: "Logs are clean." }));
	step++; // The next prompt was too large to read.
	records.push(model({ content: "Summarised the paste." }));
	const read = createResponseReader("agy", path);
	const [started, clean, pasted] = records.map(r => read(r)).filter(Boolean);
	assert.deepEqual(turnDetailsFromRecords("agy", records, clean).events.map(e => [e.kind, e.text]), [
		["prompt", "Check the logs"], ["tool", JSON.stringify(runCommand("cat log").args, null, 2)], ["result", "Created At: yesterday"],
	], "not the earlier turn's server; only agy's own timing lines are removed");
	assert.deepEqual(turnDetailsFromRecords("agy", records, started).events.map(e => e.text).at(-1), "Tool is running as a background task", "as recorded by its answer");
	const details = turnDetailsFromRecords("agy", records, pasted);
	assert.deepEqual(details.events, []);
	assert.match(details.notices.join(" "), /input prompt is not available/);
});

// A small, complete PNG, and with padding one past the 512 KiB image limit.
const pngChunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "ascii"); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
const png = (side = 2, padding = 0) => { const head = Buffer.alloc(13); head.writeUInt32BE(side, 0); head.writeUInt32BE(side, 4); head[8] = 8; head[9] = 2;
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", head), ...(padding ? [pngChunk("tEXt", Buffer.alloc(padding))] : []), pngChunk("IDAT", deflateSync(Buffer.alloc(side * (1 + 3 * side)))), pngChunk("IEND", Buffer.alloc(0))]); };

test("agy images: Working and Live show the copy agy saved beside the transcript, and no other file", async t => {
	step = 0;
	const f = fixture(t);
	const path = f.conversation(ID, { steps: [] });
	const media = join(dirname(path), "media");
	mkdirSync(media);
	const saved = (name, bytes) => { writeFileSync(join(media, name), bytes); return { mime_type: "image/png", uri: pathToFileURL(join(media, name)).href }; };
	writeFileSync(join(f.cwd, "outside.png"), png());
	symlinkSync(join(f.cwd, "outside.png"), join(media, "step_9_media_0.png"));
	const kept = saved("step_2_media_0.png", png());
	const references = [
		kept,
		{ mime_type: "image/png", uri: pathToFileURL(join(f.cwd, "outside.png")).href },
		{ mime_type: "image/png", uri: pathToFileURL(join(media, "step_9_media_0.png")).href },
		{ ...saved("step_2_media_1.png", png(2, 600 * 1024)) },
		{ ...saved("step_2_media_2.gif", Buffer.from("GIF89a")), mime_type: "image/gif" },
		{ mime_type: "application/pdf", uri: pathToFileURL(join(media, "notes.pdf")).href },
	];
	const steps = [prompt("Look at the plot"), model({ tool_calls: [{ name: "read_file", args: { Path: "/p/plot.png" } }] })];
	const result = { ...output("Showing binary file of type image/png"), media: references };
	steps.push(result, model({ content: "A square." }));
	const loaded = (await withAgyMedia(result, path)).media;
	assert.equal(loaded[0].data, png().toString("base64"), "the saved copy");
	assert.deepEqual(loaded.slice(1).map(m => m.data ?? m.unavailable ?? "-"), ["-", "-", "size", "format", "-"], "nothing outside the media folder, through a link, too large, or not an image");
	assert.equal(result.media[0].data, undefined, "the record read is not changed");
	f.append(path, ...steps);
	const answer = createResponseReader("agy", path)(steps[3]);
	const working = await readAgyTurnDetails(path, answer);
	const card = working.events.find(e => e.kind === "result");
	assert.deepEqual(card.images.map(i => i.data === undefined ? i.unavailable : "shown"), ["shown", "missing", "missing", "size", "format"]);
	assert.match(working.notices.join(" "), /Non-image file attachments are omitted/);
	// Live: the backfill, then a record as it arrives, still in order with the answer after it.
	const listeners = new Set();
	const monitor = { onRecord(id, listener) { listeners.add(listener); return () => listeners.delete(listener); } };
	const source = createLiveSource(monitor, { id: "agy-1", path, agent: "agy" }, { leases: createLiveLeases() });
	t.after(() => source.close());
	const first = await source.current();
	assert.equal((await source.snapshot(first)).events.find(e => e.kind === "result").images[0].data, png().toString("base64"));
	const next = prompt("Again");
	const again = { ...output("Showing binary file of type image/png"), media: [kept] };
	for (const listener of listeners) for (const record of [next, again, model({ content: "Same square." })]) listener(record, 100);
	await until(async () => (await source.snapshot(`s${next.step_index}`))?.status === "completed", "the live turn");
	const live = await source.snapshot(`s${next.step_index}`);
	assert.deepEqual(live.events.map(e => [e.kind, e.images?.[0]?.data === png().toString("base64")]), [["prompt", false], ["result", true], ["progress", false]]);
});

test("agy images: only agy's own layout and media folder; reads bounded by the images a turn shows", async t => {
	step = 0;
	const f = fixture(t);
	const image = (folder, name) => { writeFileSync(join(folder, name), png()); return { mime_type: "image/png", uri: pathToFileURL(join(folder, name)).href }; };
	const shown = record => record.media.filter(m => m.data).length;
	// A media folder that is a link to another folder is not agy's.
	const linked = f.conversation(SUB, { steps: [] }), elsewhere = join(f.base, "elsewhere-media");
	mkdirSync(elsewhere); symlinkSync(elsewhere, join(dirname(linked), "media"));
	assert.equal(shown(await withAgyMedia({ ...output("x"), media: [image(elsewhere, "step_1_media_0.png")] }, linked)), 0, "a linked media folder");
	// A transcript outside agy's layout names no media folder, even with one beside it.
	mkdirSync(join(f.cwd, "media"));
	const exported = join(f.cwd, "transcript_full.jsonl");
	writeFileSync(exported, "");
	assert.equal(shown(await withAgyMedia({ ...output("x"), media: [image(join(f.cwd, "media"), "plot.png")] }, exported)), 0, "an exported transcript");
	// Other attachments never take an image's place, and only `limit` images are read.
	const path = f.conversation(ID, { steps: [] }), media = join(dirname(path), "media");
	mkdirSync(media);
	const pdfs = Array.from({ length: 9 }, (_, i) => ({ mime_type: "application/pdf", uri: pathToFileURL(join(media, `d${i}.pdf`)).href }));
	const mixed = await withAgyMedia({ ...output("x"), media: [...pdfs, image(media, "after-pdfs.png")] }, path);
	assert.deepEqual([mixed.media.length, Boolean(mixed.media[9].data)], [10, true]);
	const nine = Array.from({ length: 9 }, (_, i) => image(media, `n${i}.png`));
	assert.equal(shown(await withAgyMedia({ ...output("x"), media: nine }, path, 1)), 1);
	// Live's budget: a turn's images, counted again from a prompt or after an answer.
	const budget = createAgyMediaBudget();
	const results = n => ({ ...output("x"), media: nine.slice(0, n) });
	assert.deepEqual([prompt("a"), results(7), results(9), model({ content: "done" }), results(3), prompt("b"), results(9)].map(budget), [0, 7, 1, 0, 3, 0, 8]);
	// Working reads images for the cards it shows: the last record of each step.
	const steps = [prompt("Look"), model({ tool_calls: [runCommand("plot")] })];
	const running = { ...output("Tool is running", "RUNNING"), media: nine.slice(0, 8) };
	steps.push(running, model({ tool_calls: [runCommand("again")] }));
	steps.push({ ...running, status: "DONE", content: "done", media: [image(media, "final.png")] }, model({ content: "Plotted." }));
	f.append(path, ...steps);
	const details = await readAgyTurnDetails(path, createResponseReader("agy", path)(steps.at(-1)));
	assert.deepEqual(details.events.filter(e => e.kind === "result").map(e => e.images?.map(i => i.data ? "shown" : i.unavailable)), [["shown"]]);
});

test("agy on the command line: --agent agy, and the neutral palette under the agent theme", () => {
	const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
	const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
	assert.match(help.stdout, /claude, codex, pi, opencode, agy \(default: all\)/);
	const unknown = spawnSync(process.execPath, [cli, "--agent", "gemini", "--no-open"], { encoding: "utf8" });
	assert.equal(unknown.status, 2); assert.match(unknown.stderr, /claude, codex, pi, opencode, agy or all/);
	// Accepted: parsing goes on to reject a file to watch alongside agent options.
	const accepted = spawnSync(process.execPath, [cli, "--agent", "claude,agy", "--agent-theme", "agy=codex", "README.md", "--no-open"], { encoding: "utf8" });
	assert.equal(accepted.status, 2); assert.match(accepted.stderr, /--agent-theme applies to agent sessions, not file watching/);
	assert.doesNotMatch(accepted.stderr, /Unknown agent|agy=codex/);
	assert.deepEqual(resolveTheme("agent", "light").agentThemes.agy.style, resolveTheme("neutral", "light").style);
	assert.deepEqual(resolveTheme("agent", "light", { agy: "codex" }).agentThemes.agy.style, resolveTheme("codex", "light").style);
});
