import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		const fromExtensions = pi.getAllTools().map((t) => t.name);
		const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls"];
		pi.setActiveTools([...new Set([...fromExtensions, ...builtins])]);
	});
}
