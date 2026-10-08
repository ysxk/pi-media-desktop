// The "before_provider_request" hook — sees the provider-native request body
// after the adapter built it, and replaces markers left by the context hook.
//
// Chat-completions payloads (openai-completions adapter and compatible
// gateways such as OpenRouter) accept a base64 file part:
//     {"type":"file","file":{"data":"<base64>","media_type":"<mime>"}}
// which covers audio, video and PDFs there.
//
// Every other payload shape (openai-responses, anthropic-messages, gemini,
// bedrock, …) has no such generic part, so markers are restored to the
// original "@path" text. The mention still reaches the model as text — the
// agent can still open the file with its read tool — which matches pi-media's
// "anywhere else, the mention travels on as text and nothing breaks" rule.

import { readFile } from "node:fs/promises";
import { hasMarker, makeMarker, markersToMentions, splitMarkers } from "./media.ts";

type FilePart = { type: "file"; file: { data: string; media_type: string } };
type ContentPart = { type: "text"; text: string } | FilePart;

export type RewriteOutcome = {
	payload?: unknown;
	/** Number of markers expanded to file parts. */
	attached: number;
	/** Markers that could not be inlined on this provider (restored to @path text). */
	unattachedNames: string[];
};

async function toFilePart(path: string, mediaType: string): Promise<FilePart | undefined> {
	try {
		const bytes = await readFile(path);
		return { type: "file", file: { data: bytes.toString("base64"), media_type: mediaType } };
	} catch {
		return undefined;
	}
}

async function toParts(text: string) {
	const segments = splitMarkers(text);
	if (!segments.some((segment) => segment.type === "media")) return undefined;
	const parts: ContentPart[] = [];
	for (const segment of segments) {
		if (segment.type === "text") {
			parts.push(segment);
			continue;
		}
		const part = await toFilePart(segment.path, segment.mediaType);
		parts.push(part ?? { type: "text", text: makeMarker(segment.path, segment.mediaType) });
	}
	return parts;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	const candidate = part as { type?: unknown; text?: unknown } | null;
	return !!candidate && typeof candidate === "object" && candidate.type === "text" && typeof candidate.text === "string";
}

function isImageUrlPart(part: unknown): boolean {
	const candidate = part as { type?: unknown } | null;
	return !!candidate && typeof candidate === "object" && candidate.type === "image_url";
}

/**
 * Detect the chat-completions message shape: content is a string, or an array
 * whose parts are limited to text/image_url/file. An Anthropic body (image
 * parts carry `source.media_type`) or a Responses body (`input` array) must
 * not enter the file-part branch.
 */
function isChatCompletionsContent(content: unknown): boolean {
	if (typeof content === "string") return true;
	if (!Array.isArray(content)) return false;
	return content.every((part) => isTextPart(part) || isImageUrlPart(part) || (part as { type?: unknown })?.type === "file");
}

function isChatCompletionsPayload(payload: { messages?: unknown }): boolean {
	const record = payload as Record<string, unknown>;
	// Definitely not chat-completions: Responses API uses `input`, Gemini uses
	// `contents`. Checked first so an unusual body with both keys routes away.
	if (Array.isArray(record.input) || Array.isArray(record.contents)) return false;
	const messages = record.messages;
	if (!Array.isArray(messages)) return false;
	// anthropic-messages bodies put image parts as {type:"image",source:...}
	// which isChatCompletionsContent rejects.
	return messages.some(
		(msg) => msg && typeof msg === "object" && isChatCompletionsContent((msg as { content?: unknown }).content),
	);
}

async function rewriteContent(content: unknown) {
	if (typeof content === "string") return toParts(content);
	if (!Array.isArray(content)) return undefined;
	const rewritten = await Promise.all(content.map((part) => (isTextPart(part) ? toParts(part.text) : undefined)));
	if (rewritten.every((parts) => parts === undefined)) return undefined;
	return content.flatMap((part, index) => rewritten[index] ?? [part]);
}

/** Expand markers to file parts in a chat-completions payload. Original pi-media logic. */
async function expandChatCompletions(payload: { messages: unknown[] }) {
	const messages = payload.messages;
	const contents = await Promise.all(
		messages.map((msg) => (msg && typeof msg === "object" ? rewriteContent((msg as { content?: unknown }).content) : undefined)),
	);
	if (contents.every((content) => content === undefined)) return undefined;
	const body = payload as Record<string, unknown>;
	return {
		...body,
		messages: messages.map((msg, index) => (contents[index] ? { ...(msg as object), content: contents[index] } : msg)),
	};
}

function collectMarkerPaths(text: string, out: string[]) {
	for (const segment of splitMarkers(text)) {
		if (segment.type === "media") out.push(segment.path);
	}
}

/** Walk any payload shape, restore markers to @path text, and collect the file names. */
function restoreMarkersDeep(value: unknown, out: string[]): unknown {
	if (typeof value === "string") {
		if (!hasMarker(value)) return value;
		collectMarkerPaths(value, out);
		return markersToMentions(value);
	}
	if (Array.isArray(value)) return value.map((item) => restoreMarkersDeep(item, out));
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(record)) {
			const restored = restoreMarkersDeep(item, out);
			if (restored !== item) changed = true;
			next[key] = restored;
		}
		return changed ? next : value;
	}
	return value;
}

function countAttachedFiles(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAttachedFiles(item), 0);
	const record = value as Record<string, unknown>;
	let count = record.type === "file" && typeof (record.file as { data?: unknown })?.data === "string" ? 1 : 0;
	for (const item of Object.values(record)) count += countAttachedFiles(item);
	return count;
}

function collectMarkerPathsDeep(value: unknown, out: string[]) {
	if (typeof value === "string") {
		if (hasMarker(value)) collectMarkerPaths(value, out);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectMarkerPathsDeep(item, out);
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) collectMarkerPathsDeep(item, out);
	}
}

export async function rewritePayload(payload: unknown): Promise<RewriteOutcome> {
	if (!payload || typeof payload !== "object") return { attached: 0, unattachedNames: [] };
	const body = payload as { messages?: unknown };

	// All markers present in the original payload — used to report anything
	// that does not end up inlined as a file part.
	const markerPaths: string[] = [];
	collectMarkerPathsDeep(payload, markerPaths);

	if (isChatCompletionsPayload(body)) {
		const rewritten = await expandChatCompletions(body as { messages: unknown[] });
		if (rewritten === undefined) return { attached: 0, unattachedNames: [] };
		const attached = countAttachedFiles(rewritten);
		// Markers that survived expansion are files that became unreadable
		// between the scan and the read — surface them rather than fail silently.
		const unattached = attached >= markerPaths.length ? [] : markerPaths.slice(attached);
		return { payload: rewritten, attached, unattachedNames: unattached };
	}

	// Any other provider shape: restore markers to plain @path text so the model
	// sees a clean mention it can choose to open, and report the skipped files.
	const names: string[] = [];
	const restored = restoreMarkersDeep(payload, names);
	if (names.length === 0) return { attached: 0, unattachedNames: [] };
	return { payload: restored, attached: 0, unattachedNames: names };
}
