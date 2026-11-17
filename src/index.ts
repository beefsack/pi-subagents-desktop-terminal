import { spawn } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  InspectorContext,
  InspectorLaunch,
  InspectorPlugin,
  InspectorRegistration,
  InspectorRegistrationRequest,
} from "pi-subagents/inspectors";
import { resolveTerminal, systemDeps } from "./resolve.ts";

type Result = Awaited<ReturnType<InspectorPlugin["open"]>>;

function result(text: string, isError = false): Result {
  const response: AgentToolResult<Result["details"]> & { isError?: boolean } = {
    content: [{ type: "text", text }],
    details: { mode: "management", results: [] },
  };
  if (isError) response.isError = true;
  return response;
}

const hasDisplay = (context: InspectorContext) =>
  process.platform === "linux" && Boolean(context.env.WAYLAND_DISPLAY || context.env.DISPLAY);

async function open(context: InspectorContext, launch: InspectorLaunch): Promise<Result> {
  const terminal = await resolveTerminal(systemDeps(context.env));
  if (!terminal) return result("Desktop terminal inspector error: no default terminal found.", true);
  const cwd = context.target.status.cwd ?? context.cwd;
  const [command, ...args] = terminal.argv(cwd, [launch.executable, ...launch.argv]);
  try {
    const child = spawn(command!, args, { cwd, env: context.env, detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return result(`Desktop terminal inspector error: ${message} (from ${terminal.source}).`, true);
  }
  return result(
    `Opened read-only desktop terminal inspector (${terminal.source}) for async run ${context.target.runId}. Status and close are unavailable because this plugin writes no binding.`,
  );
}

const plugin: InspectorPlugin = {
  name: "desktop-terminal",
  available: async (context) => hasDisplay(context) && (await resolveTerminal(systemDeps(context.env))) !== undefined,
  owns: () => false,
  open,
};

export default function (pi: ExtensionAPI) {
  let registration: InspectorRegistration | undefined;
  pi.on("session_start", () => {
    registration?.dispose();
    const request: InspectorRegistrationRequest = { version: 1, plugin };
    pi.events.emit("pi-subagents:inspector-register:v1", request);
    if (!request.result) throw new Error("pi-subagents inspector registration is unavailable.");
    if (!request.result.ok) throw request.result.error;
    registration = request.result.registration;
  });
  pi.on("session_shutdown", () => registration?.dispose());
}
