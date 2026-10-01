import { describe, expect, mock, test } from "bun:test";

mock.module("@oh-my-pi/pi-coding-agent", () => ({
	SUBAGENT_ROUTING_API_VERSION: undefined,
	getSupportedEfforts: (model: { thinking: { efforts: string[] } }) => model.thinking.efforts,
}));
// A static import would load the extension before the mocked API version is registered.
const { default: intelligentAutoAgents } = await import("./index.ts");

const unsupportedMessage =
	"intelligent-auto-agents disabled: this OMP lacks subagent routing API v2, so Jev's subagent hook cannot run here. See this plugin's README.md and run core/install-omp.sh to install the patched OMP.";

describe("intelligent auto-agents on stock OMP", () => {
	test("logs once without a startup popup and reports manual invocations informationally", async () => {
		const warnings: string[] = [];
		const hooks: string[] = [];
		const notifications: Array<[string, string]> = [];
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

		await intelligentAutoAgents({
			logger: { warn: (message: string) => warnings.push(message) },
			on: (name: string) => hooks.push(name),
			registerCommand: (name: string, command: unknown) =>
				commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<void> }),
		} as unknown as Parameters<typeof intelligentAutoAgents>[0]);

		expect(warnings).toEqual([unsupportedMessage]);
		expect(hooks).toEqual([]);
		const ctx = {
			ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
		};
		const command = commands.get("auto-agents");
		expect(command).toBeDefined();
		expect(notifications).toEqual([]);
		await command?.handler("on", ctx);
		await command?.handler("status", ctx);
		expect(notifications).toEqual([
			[unsupportedMessage, "info"],
			[unsupportedMessage, "info"],
		]);
	});
});
