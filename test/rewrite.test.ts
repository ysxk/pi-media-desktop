import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeMarker } from "../src/media.ts";
import { rewritePayload } from "../src/rewrite.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-media-rewrite-"));
const pdfPath = join(dir, "doc.pdf");
await writeFile(pdfPath, "%PDF-1.4");

const marker = makeMarker(pdfPath, "application/pdf");
const fileBlock = {
	type: "file",
	file: { data: Buffer.from("%PDF-1.4").toString("base64"), media_type: "application/pdf" },
};

test("inlines a marker in string content as a file block (chat-completions)", async () => {
	const outcome = await rewritePayload({ model: "m", messages: [{ role: "user", content: `read this\n\n${marker}` }] });
	assert.equal(outcome.attached, 1);
	assert.deepEqual(outcome.payload, {
		model: "m",
		messages: [{ role: "user", content: [{ type: "text", text: "read this" }, fileBlock] }],
	});
});

test("inlines markers inside array content and keeps other parts", async () => {
	const outcome = await rewritePayload({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: `${marker} summarize` },
					{ type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
				],
			},
		],
	});
	assert.equal(outcome.attached, 1);
	assert.deepEqual(outcome.payload, {
		messages: [
			{
				role: "user",
				content: [
					fileBlock,
					{ type: "text", text: "summarize" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
				],
			},
		],
	});
});

test("keeps the marker as text and reports it when the file is gone", async () => {
	const missing = makeMarker(join(dir, "gone.pdf"), "application/pdf");
	const outcome = await rewritePayload({ messages: [{ role: "user", content: missing }] });
	assert.equal(outcome.attached, 0);
	assert.deepEqual(outcome.unattachedNames, [join(dir, "gone.pdf")]);
	assert.deepEqual(outcome.payload, {
		messages: [{ role: "user", content: [{ type: "text", text: missing }] }],
	});
});

test("returns no-op when nothing matches", async () => {
	assert.deepEqual(await rewritePayload({ messages: [{ role: "user", content: "hello" }] }), { attached: 0, unattachedNames: [] });
	assert.deepEqual(await rewritePayload({ messages: [{ role: "assistant", content: null }] }), { attached: 0, unattachedNames: [] });
	assert.deepEqual(await rewritePayload(undefined), { attached: 0, unattachedNames: [] });
	assert.deepEqual(await rewritePayload("raw"), { attached: 0, unattachedNames: [] });
	assert.deepEqual(await rewritePayload({ foo: 1 }), { attached: 0, unattachedNames: [] });
});

test("leaves untouched messages by reference", async () => {
	const untouched = { role: "system", content: "sys" };
	const outcome = await rewritePayload({ messages: [untouched, { role: "user", content: marker }] });
	assert.equal((outcome.payload as { messages: unknown[] }).messages[0], untouched);
});

// --- Non chat-completions shapes: restore @path text so the model sees a clean mention ---

test("anthropic-shaped payloads restore markers to @path text and report them", async () => {
	const payload = {
		model: "claude",
		max_tokens: 1024,
		system: "sys",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: `what is ${marker}` },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "xx" } },
				],
			},
		],
	};
	const outcome = await rewritePayload(payload);
	assert.equal(outcome.attached, 0);
	assert.deepEqual(outcome.unattachedNames, [pdfPath]);
	assert.deepEqual((outcome.payload as typeof payload).messages[0].content, [
		{ type: "text", text: `what is @${pdfPath}` },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "xx" } },
	]);
});

test("openai-responses shaped payloads restore markers to @path text", async () => {
	const outcome = await rewritePayload({ model: "gpt", input: [{ role: "user", content: marker }] });
	assert.equal(outcome.attached, 0);
	assert.deepEqual(outcome.unattachedNames, [pdfPath]);
	assert.deepEqual(outcome.payload, { model: "gpt", input: [{ role: "user", content: `@${pdfPath}` }] });
});

test("gemini-shaped payloads expand markers to inlineData parts", async () => {
	const outcome = await rewritePayload({
		model: "gemini",
		contents: [{ role: "user", parts: [{ text: `see ${marker} now` }] }],
	});
	assert.equal(outcome.attached, 1);
	assert.deepEqual(outcome.unattachedNames, []);
	assert.deepEqual(outcome.payload, {
		model: "gemini",
		contents: [
			{
				role: "user",
				parts: [
					{ text: "see" },
					{ inlineData: { data: Buffer.from("%PDF-1.4").toString("base64"), mimeType: "application/pdf" } },
					{ text: "now" },
				],
			},
		],
	});
});

test("gemini payload with multiple mentions in one part expands all", async () => {
	const dir2 = await mkdtemp(join(tmpdir(), "pi-media-gemini-"));
	await writeFile(join(dir2, "a.mp3"), "audio");
	await writeFile(join(dir2, "b.mp4"), "video");
	const aMarker = makeMarker(join(dir2, "a.mp3"), "audio/mpeg");
	const bMarker = makeMarker(join(dir2, "b.mp4"), "video/mp4");
	const outcome = await rewritePayload({
		contents: [{ role: "user", parts: [{ text: `${aMarker} and ${bMarker}` }] }],
	});
	assert.equal(outcome.attached, 2);
	const parts = (outcome.payload as { contents: { parts: unknown[] }[] }).contents[0].parts;
	assert.deepEqual(parts, [
		{ inlineData: { data: Buffer.from("audio").toString("base64"), mimeType: "audio/mpeg" } },
		{ text: "and" },
		{ inlineData: { data: Buffer.from("video").toString("base64"), mimeType: "video/mp4" } },
	]);
});

test("gemini payload keeps marker text when file is unreadable", async () => {
	const missing = makeMarker(join(dir, "gone.mp3"), "audio/mpeg");
	const outcome = await rewritePayload({
		contents: [{ role: "user", parts: [{ text: missing }] }],
	});
	assert.equal(outcome.attached, 0);
	assert.deepEqual(outcome.unattachedNames, [join(dir, "gone.mp3")]);
	assert.deepEqual(outcome.payload, {
		contents: [{ role: "user", parts: [{ text: missing }] }],
	});
});

test("gemini payload without markers returns no-op", async () => {
	const outcome = await rewritePayload({
		contents: [{ role: "user", parts: [{ text: "hello" }] }],
	});
	assert.deepEqual(outcome, { attached: 0, unattachedNames: [] });
});

test("assistant messages containing markers in chat-completions payloads also expand", async () => {
	// Parity with the original: markers are expanded regardless of role —
	// stale markers survive in transcript text across compaction/summary turns.
	const outcome = await rewritePayload({ messages: [{ role: "assistant", content: marker }] });
	assert.equal(outcome.attached, 1);
});
