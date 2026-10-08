// Ported from pi-media's media.ts. The original rewrote the submitted text at
// the "input" hook. PI-Desktop v1 does not emit "input", so the scans below are
// exposed as pure helpers and driven by the "context" hook (see context.ts).

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const MARKER_RE = /\[\[pi-media:([^|\]]+)\|([^|\]]+)\]\]/g;
const MARKER_PREFIX = "[[pi-media:";

// Input types Gemini models accept. Everything else stays plain text for pi's read tool.
// https://ai.google.dev/gemini-api/docs/generate-content/{image,audio,video,document}-understanding
const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
	wav: "audio/wav",
	mp3: "audio/mpeg",
	aac: "audio/aac",
	flac: "audio/flac",
	ogg: "audio/ogg",
	aiff: "audio/aiff",
	aif: "audio/aiff",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mpeg: "video/mpeg",
	mpg: "video/mpeg",
	avi: "video/avi",
	wmv: "video/wmv",
	flv: "video/x-flv",
	"3gp": "video/3gpp",
	pdf: "application/pdf",
};

// Files above this are left as plain @paths — base64 in memory would risk an OOM.
// Raise it, or upload and send a URL instead, if large video matters.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const AT_PATH_RE = /(?:^|[\s([{])@(?:"([^"]+)"|(\S+))/g;
const TRAILING_PUNCTUATION_RE = /[)\],.;:!?]+$/;

export function makeMarker(path: string, mediaType: string) {
	return `[[pi-media:${path}|${mediaType}]]`;
}

export function isImageMime(mediaType: string) {
	return mediaType.startsWith("image/");
}

function mediaTypeFromExtension(path: string) {
	return MIME_BY_EXTENSION[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

export type Mention = {
	/** Start of the matched text segment that ends just before the "@". */
	index: number;
	/** Offset of the "@" character itself. */
	at: number;
	/** Offset just past the mention (before any trailing punctuation). */
	end: number;
	/** The path as written by the user (quotes stripped, punctuation stripped). */
	mention: string;
	/** Absolute path resolved against cwd. */
	path: string;
	mediaType: string;
	/** Punctuation trimmed off the end of an unquoted mention — stays outside. */
	trailing: string;
};

async function isAttachable(path: string) {
	try {
		const stats = await stat(path);
		return stats.isFile() && stats.size > 0 && stats.size <= MAX_ATTACHMENT_BYTES;
	} catch {
		return false;
	}
}

/**
 * Find attachable @path mentions in `text`, resolved against `cwd`.
 * Returns structured matches without rewriting anything.
 */
export async function extractMentions(text: string, cwd: string): Promise<Mention[]> {
	const mentions: Mention[] = [];
	for (const match of text.matchAll(AT_PATH_RE)) {
		const quoted = match[1];
		const trailing = quoted ? "" : (match[2].match(TRAILING_PUNCTUATION_RE)?.[0] ?? "");
		const mention = quoted ?? match[2].slice(0, match[2].length - trailing.length);
		const mediaType = mediaTypeFromExtension(mention);
		if (!mediaType) continue;
		const path = resolve(cwd, mention);
		if (!(await isAttachable(path))) continue;
		const at = match.index + match[0].indexOf("@");
		mentions.push({
			index: match.index,
			at,
			end: match.index + match[0].length - trailing.length,
			mention,
			path,
			mediaType,
			trailing,
		});
	}
	return mentions;
}

/**
 * Rewrite @path mentions in `text` to markers, keeping trailing punctuation outside.
 * Returns undefined when nothing attachable was mentioned (original pi-media semantics).
 */
export async function attachLocalMedia(text: string, cwd: string): Promise<string | undefined> {
	const mentions = await extractMentions(text, cwd);
	if (mentions.length === 0) return undefined;
	let result = "";
	let last = 0;
	for (const m of mentions) {
		result += text.slice(last, m.at) + makeMarker(m.path, m.mediaType) + m.trailing;
		last = m.index + (m.end - m.index) + m.trailing.length;
	}
	return result + text.slice(last);
}

export type MediaSegment = { type: "text"; text: string } | { type: "media"; path: string; mediaType: string };

export function splitMarkers(text: string): MediaSegment[] {
	const segments: MediaSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(MARKER_RE)) {
		const before = text.slice(last, match.index).trim();
		if (before) segments.push({ type: "text", text: before });
		segments.push({ type: "media", path: match[1], mediaType: match[2] });
		last = match.index + match[0].length;
	}
	const after = text.slice(last).trim();
	if (after) segments.push({ type: "text", text: after });
	return segments;
}

/** True when text contains at least one marker. (Regex-free — shared `g` regexes carry lastIndex state between calls.) */
export function hasMarker(text: string): boolean {
	return text.includes(MARKER_PREFIX);
}

/** Replace every marker with its original `@path` text (used when a provider can't take the attachment). */
export function markersToMentions(text: string): string {
	return text.replace(MARKER_RE, (_whole, path: string) => `@${path}`);
}
