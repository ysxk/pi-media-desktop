// The "context" hook transform — runs before every LLM call on a detached
// copy of the conversation. It routes @path mentions two ways:
//
//   image + model accepts images → inline {type:"image"} content part
//                                   (every provider adapter serializes these)
//   audio / video / pdf (or image without support) → [[pi-media:path|mime]]
//                                   marker text for the before_provider_request
//                                   hook to expand when the provider can take it.
//
// Only the returned copy is changed; the durable transcript keeps the
// original "@path" text, so every turn re-scans and re-attaches — match for
// pi-media's "re-sent on every turn" semantics, and idempotent by construction.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractMentions, isImageMime, makeMarker } from "./media.ts";

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };
export type MessageContent = string | Array<TextContent | ImageContent | { type: string }>;
export type AgentMessageLike = { role?: string; content?: unknown };

// Bound the work a single call can trigger: the hook has a 30s budget and
// files can be up to 20 MB each.
const MAX_ATTACHMENTS_PER_CALL = 8;

function isTextPart(part: unknown): part is TextContent {
	const candidate = part as { type?: unknown; text?: unknown } | null;
	return !!candidate && typeof candidate === "object" && candidate.type === "text" && typeof candidate.text === "string";
}

async function toImagePart(path: string, mimeType: string, mention: string): Promise<TextContent | ImageContent> {
	try {
		const bytes = await readFile(path);
		return { type: "image", data: bytes.toString("base64"), mimeType };
	} catch {
		// Gone or unreadable between the scan and the read: degrade to the typed text.
		return { type: "text", text: `@${mention}` };
	}
}

/**
 * Rewrite one text body. Returns a parts array when anything attached, or
 * undefined when the text is untouched.
 */
export async function rewriteTextContent(
	text: string,
	cwd: string,
	supportsImages: boolean,
	budget: { remaining: number },
): Promise<Array<TextContent | ImageContent> | undefined> {
	const mentions = await extractMentions(text, cwd);
	if (mentions.length === 0) return undefined;

	const parts: Array<TextContent | ImageContent> = [];
	let last = 0;

	const pushText = (value: string) => {
		if (value.trim().length > 0) parts.push({ type: "text", text: value });
	};

	for (const m of mentions) {
		const overBudget = budget.remaining <= 0;
		const asImage = !overBudget && isImageMime(m.mediaType) && supportsImages;

		pushText(text.slice(last, m.at));

		if (asImage) {
			budget.remaining -= 1;
			parts.push(await toImagePart(m.path, m.mediaType, m.mention));
			// Textual grounding so the model knows what the image is, and a
			// stable handle if a later turn strips the image again.
			pushText(`[image: ${basename(m.mention)}]`);
		} else {
			// marker carries the absolute path and MIME for the payload hook.
			pushText(makeMarker(m.path, m.mediaType));
		}
		pushText(m.trailing);
		last = m.end + m.trailing.length;
	}

	pushText(text.slice(last));
	return parts;
}

/**
 * Scan user messages in `messages` and attach mentioned files. Returns a new
 * array only when something changed — unchanged messages keep their identity,
 * and undefined means "no transform" (which the host treats as a fast path).
 */
export async function transformMessages(
	messages: AgentMessageLike[],
	cwd: string,
	supportsImages: boolean,
): Promise<AgentMessageLike[] | undefined> {
	const budget = { remaining: MAX_ATTACHMENTS_PER_CALL };
	let changedAny = false;

	const rewritten = await Promise.all(
		messages.map(async (msg) => {
			if (!msg || typeof msg !== "object" || msg.role !== "user") return undefined;
			const content = msg.content;
			if (typeof content === "string") {
				const parts = await rewriteTextContent(content, cwd, supportsImages, budget);
				if (!parts) return undefined;
				// Collapse back to a string when the scan produced text only — keeps
				// the message shape stable for providers that expect plain strings.
				return parts.every((p) => p.type === "text")
					? { ...msg, content: parts.map((p) => p.text).join("") }
					: { ...msg, content: parts };
			}
			if (Array.isArray(content)) {
				const partResults = await Promise.all(
					content.map((part) => (isTextPart(part) ? rewriteTextContent(part.text, cwd, supportsImages, budget) : undefined)),
				);
				if (partResults.every((r) => r === undefined)) return undefined;
				return { ...msg, content: (content as unknown[]).flatMap((part, i) => partResults[i] ?? [part]) };
			}
			return undefined;
		}),
	);

	if (rewritten.every((r) => r === undefined)) return undefined;
	changedAny = true;
	return messages.map((msg, i) => rewritten[i] ?? msg);
}
