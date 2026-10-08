// pi-media-desktop — plugin host entry.
// All real work happens in the agent extension (src/index.ts), which the
// agent sidecar loads at the next turn via `contributes.agentExtensions`.
// This file only satisfies the manifest's required `main` field.

async function onLoad() {}

async function onUnload() {}

module.exports = { onLoad, onUnload };
