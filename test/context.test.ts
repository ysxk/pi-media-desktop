import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transformMessages } from "../src/context.ts";
import { makeMarker } from "../src/media.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-media-context-"));
const pngPath = join(dir, "shot.png");
const pdfPath = join(dir, "doc.pdf");
await writeFile(pngPath, "png-bytes");
await writeFile(pdfPath, "%PDF-1.4");

const pngBase64 = Buffer.from("png-bytes").toString("base64");

test("attaches an image as an image part when the model accepts images", async () => {
	const result = await transformMessages([{ role: "user", content: `look at @shot.png please` }], dir, true);
	const content = (result?.[0] as { content: unknown[] }).content;
	assert.deepEqual(content, [
		{ type: "text", text: "look at " },
		{ type: "image", data: pngBase64, mimeType: "image/png" },
		{ type: "text", text: "[image: shot.png]" },
		{ type: "text", text: " please" },
	]);
});

test("routes images to markers when the model lacks image input", async () => {
	const result = await transformMessages([{ role: "user", content: "look at @shot.png" }], dir, false);
	assert.deepEqual(result, [{ role: "user", content: `look at ${makeMarker(pngPath, "image/png")}` }]);
});

test("routes audio and pdf mentions to markers regardless of image support", async () => {
	const result = await transformMessages([{ role: "user", content: "read @doc.pdf now" }], dir, true);
	assert.deepEqual(result, [{ role: "user", content: `read ${makeMarker(pdfPath, "application/pdf")} now` }]);
});

test("keeps mentions of missing files as typed text", async () => {
	assert.equal(await transformMessages([{ role: "user", content: "see @gone.pdf" }], dir, true), undefined);
});

test("leaves assistant and toolResult messages untouched", async () => {
	const assistant = { role: "assistant", content: [{ type: "text", text: "saw @shot.png" }] };
	const messages = [{ role: "user", content: "hi" }, assistant];
	assert.equal(await transformMessages(messages, dir, true), undefined);
});

test("rewrites text parts inside array content and keeps other parts", async () => {
	const imagePart = { type: "image", data: "other", mimeType: "image/jpeg" };
	const result = await transformMessages(
		[{ role: "user", content: [{ type: "text", text: "what is in @doc.pdf?" }, imagePart] }],
		dir,
		true,
	);
	const content = (result?.[0] as { content: unknown[] }).content;
	assert.deepEqual(content, [
		{ type: "text", text: "what is in " },
		{ type: "text", text: makeMarker(pdfPath, "application/pdf") },
		{ type: "text", text: "?" },
		imagePart,
	]);
});

test("idempotent across turns: the original text keeps its @path so every call re-attaches", async () => {
	const original = [{ role: "user", content: "look at @shot.png" }];
	const first = await transformMessages(original, dir, true);
	const second = await transformMessages(original, dir, true);
	assert.deepEqual(second, first);
	// The durable message is never mutated.
	assert.equal(original[0].content, "look at @shot.png");
});

test("multiple mentions in one message all attach images in order", async () => {
	const dir2 = await mkdtemp(join(tmpdir(), "pi-media-context-"));
	await writeFile(join(dir2, "a.png"), "A");
	await writeFile(join(dir2, "b.png"), "B");
	const result = await transformMessages([{ role: "user", content: "@a.png vs @b.png" }], dir2, true);
	const content = (result?.[0] as { content: Array<{ type: string; data?: string }> }).content;
	assert.equal(content.filter((p) => p.type === "image").length, 2);
	assert.equal(content.filter((p) => p.type === "image").at(0)?.data, Buffer.from("A").toString("base64"));
	assert.equal(content.filter((p) => p.type === "image").at(1)?.data, Buffer.from("B").toString("base64"));
});
