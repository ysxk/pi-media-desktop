// Minimal ExtensionAPI surface used by this plugin, declared locally so the
// plugin has zero runtime dependencies. The real API is injected by the
// PI-Desktop agent sidecar at load time.

declare module "@earendil-works/pi-coding-agent" {
	export type ImageContent = { type: "image"; data: string; mimeType: string };

	export interface ModelLike {
		id?: string;
		input?: string[];
	}

	export interface ExtensionUIContext {
		notify(message: string, kind?: "info" | "warning" | "error"): void;
	}

	export interface ExtensionContext {
		cwd: string;
		ui: ExtensionUIContext;
		model?: ModelLike;
		signal?: AbortSignal;
	}

	export type AgentMessage = { role?: string; content?: unknown; [key: string]: unknown };

	export interface ContextEvent {
		type: "context";
		messages: AgentMessage[];
	}
	export interface ContextEventResult {
		messages?: AgentMessage[];
	}

	export interface BeforeProviderRequestEvent {
		type: "before_provider_request";
		payload: unknown;
	}

	type Handler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

	export interface ExtensionAPI {
		on(event: "context", handler: Handler<ContextEvent, ContextEventResult>): () => void;
		on(event: "before_provider_request", handler: Handler<BeforeProviderRequestEvent, unknown>): () => void;
	}
}
