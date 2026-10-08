// pi-media agent extension — PI-Desktop edition.
//
// PI-Desktop loads this module into the agent sidecar through the plugin's
// `contributes.agentExtensions` and hands it the pi CLI ExtensionAPI. The
// desktop does not emit the "input" event in v1, so unlike the pi CLI
// original, @path mentions are picked up in the "context" hook (which fires
// before every LLM call with the full transcript) instead of at submit time.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transformMessages } from "./context.ts";
import { rewritePayload } from "./rewrite.ts";

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event, ctx) => {
		const supportsImages = ctx.model?.input?.includes("image") === true;
		const messages = await transformMessages(event.messages, ctx.cwd, supportsImages);
		// Returning undefined means "no transform" — the host keeps its fast
		// path and later handlers still run. Returning {messages} replaces.
		return messages === undefined ? undefined : { messages };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const outcome = await rewritePayload(event.payload);
		if (outcome.unattachedNames.length > 0) {
			const names = outcome.unattachedNames.map((name) => name.split("/").pop() ?? name).join(", ");
			ctx.ui.notify(
				`pi-media: could not attach ${names} — this provider has no inline file part. The @path was sent as text instead.`,
				"warning",
			);
		}
		return outcome.payload;
	});
}
