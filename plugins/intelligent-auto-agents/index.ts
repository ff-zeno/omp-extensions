// The extension loads on stock OMP so it can explain why routing is unavailable without crashing startup.
// The routing runtime is imported only after the patched API check passes.
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const UNSUPPORTED =
	"intelligent-auto-agents disabled: this OMP lacks subagent routing API v2, so Jev's subagent hook cannot run here. See this plugin's README.md and run core/install-omp.sh to install the patched OMP.";

export default async function intelligentAutoAgents(pi: ExtensionAPI): Promise<void> {
	if (Reflect.get(codingAgent, "SUBAGENT_ROUTING_API_VERSION") !== 2) {
		pi.logger.warn(UNSUPPORTED);
		pi.registerCommand("auto-agents", {
			description: "Show why intelligent auto-agents is unavailable in this OMP runtime",
			handler: async (_args, ctx) => {
				ctx.ui.notify(UNSUPPORTED, "info");
			},
		});
		return;
	}
	// Dynamic on purpose: runtime.ts imports packages stock OMP does not expose to extensions.
	const { register } = await import("./runtime");
	register(pi);
}
