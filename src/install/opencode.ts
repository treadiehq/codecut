import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODECUT_GENERATED_FILE_MARKER,
  isCodecutOpenCodePlugin,
} from "../core/managed-files.js";

export const OPENCODE_HOOK_EVENTS = [
  "tool.execute.before",
  "tool.execute.after",
  "session.idle",
  "session.compacted",
] as const;

type OpenCodeHookEvent = (typeof OPENCODE_HOOK_EVENTS)[number];

export function openCodePluginPath(
  rootDirectory: string,
  options: {
    userLevel?: boolean;
    environment?: NodeJS.ProcessEnv;
  } = {},
): string {
  if (!options.userLevel) {
    return path.join(rootDirectory, ".opencode", "plugins", "codecut.js");
  }
  const configDirectory =
    options.environment?.XDG_CONFIG_HOME?.trim() ||
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(rootDirectory, ".config");
  return path.join(configDirectory, "opencode", "plugins", "codecut.js");
}

export function openCodePluginSource(options: {
  userLevel?: boolean;
} = {}): string {
  const userArguments = options.userLevel ? ', "--user"' : "";
  const executable = options.userLevel
    ? 'process.env.CODECUT_BIN || "codecut"'
    : 'join(directory, ".codecut", "runtime", process.platform === "win32" ? "codecut.exe" : "codecut")';

  return `${CODECUT_GENERATED_FILE_MARKER}
import { join } from "node:path";

export const CodecutPlugin = async ({ client, directory }) => {
  const continuedSessions = new Set();
  const executable = ${executable};

  const log = async (level, message, extra = {}) => {
    try {
      await client.app.log({
        body: { service: "codecut", level, message, extra },
      });
    } catch {
      // Logging must never change agent behavior.
    }
  };

  const runCodecut = async (payload) => {
    const child = Bun.spawn(
      [executable, "hook", "--agent", "opencode"${userArguments}],
      {
        cwd: directory,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(JSON.stringify({ ...payload, cwd: directory }));
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (stderr.trim()) {
      await log("warn", stderr.trim());
    }
    if (exitCode !== 0) {
      throw new Error(
        \`Codecut exited with status \${exitCode}: \${stderr.trim() || stdout.trim()}\`,
      );
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("Codecut returned invalid JSON.");
    }
  };

  const latestAssistantMessage = async (sessionID) => {
    try {
      const response = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      const messages = Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response)
          ? response
          : [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.info?.role !== "assistant") continue;
        return (message.parts || [])
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\\n");
      }
    } catch (error) {
      await log("warn", "Could not read the latest OpenCode response.", {
        error: String(error),
      });
    }
    return undefined;
  };

  const reportAdvisory = async (result) => {
    if (typeof result?.reason === "string" && result.reason.trim()) {
      await log("warn", result.reason);
    }
  };

  return {
    "tool.execute.before": async (input, output) => {
      const result = await runCodecut({
        event: "tool.execute.before",
        session_id: input.sessionID,
        tool_name: input.tool,
        call_id: input.callID,
        tool_input: output.args,
      });
      if (result?.outcome === "deny" || result?.outcome === "continue") {
        throw new Error(result.reason || "Codecut blocked this tool call.");
      }
      await reportAdvisory(result);
    },

    "tool.execute.after": async (input, output) => {
      const result = await runCodecut({
        event: "tool.execute.after",
        session_id: input.sessionID,
        tool_name: input.tool,
        call_id: input.callID,
        tool_input: input.args,
        tool_output: {
          title: output.title,
          output: output.output,
          metadata: output.metadata,
        },
      });
      await reportAdvisory(result);
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        continuedSessions.delete(event.properties?.info?.id || event.properties?.sessionID);
        return;
      }
      if (event.type === "session.compacted") {
        const sessionID = event.properties.sessionID;
        continuedSessions.delete(sessionID);
        await runCodecut({
          event: "session.compacted",
          session_id: sessionID,
        });
        return;
      }
      if (event.type !== "session.idle") return;

      const sessionID = event.properties.sessionID;
      const result = await runCodecut({
        event: "session.idle",
        session_id: sessionID,
        stop_hook_active: continuedSessions.has(sessionID),
        last_assistant_message: await latestAssistantMessage(sessionID),
      });
      if (result?.outcome !== "continue") {
        continuedSessions.delete(sessionID);
        await reportAdvisory(result);
        return;
      }

      continuedSessions.add(sessionID);
      const reason =
        typeof result.reason === "string" && result.reason.trim()
          ? result.reason
          : "Codecut needs another pass before this task is complete.";
      await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          parts: [{ type: "text", text: reason, synthetic: true }],
        },
      });
    },
  };
};
`;
}

async function readPlugin(pluginPath: string): Promise<string | undefined> {
  try {
    return await readFile(pluginPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function validateOpenCodeSettings(
  projectRoot: string,
): Promise<void> {
  const pluginPath = openCodePluginPath(projectRoot);
  const existing = await readPlugin(pluginPath);
  if (existing !== undefined && !isCodecutOpenCodePlugin(existing)) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, pluginPath)} safely: the file already exists and is not managed by Codecut.`,
    );
  }
}

export async function inspectOpenCodePlugin(
  pluginPath: string,
): Promise<OpenCodeHookEvent[]> {
  const source = await readPlugin(pluginPath);
  if (!source || !isCodecutOpenCodePlugin(source)) {
    return [];
  }
  return OPENCODE_HOOK_EVENTS.filter((event) => source.includes(`"${event}"`));
}

export async function installOpenCodeHooks(
  rootDirectory: string,
  options: {
    userLevel?: boolean;
    pluginPath?: string;
  } = {},
): Promise<{
  settingsPath: string;
  addedEvents: OpenCodeHookEvent[];
}> {
  const settingsPath =
    options.pluginPath ??
    openCodePluginPath(rootDirectory, { userLevel: options.userLevel });
  const existing = await readPlugin(settingsPath);
  if (existing !== undefined && !isCodecutOpenCodePlugin(existing)) {
    throw new Error(
      `Cannot update ${path.relative(rootDirectory, settingsPath)} safely: the file already exists and is not managed by Codecut.`,
    );
  }

  const source = openCodePluginSource({ userLevel: options.userLevel });
  const addedEvents = existing === source ? [] : [...OPENCODE_HOOK_EVENTS];
  if (addedEvents.length === 0) {
    return { settingsPath, addedEvents };
  }

  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.codecut.tmp`;
  await writeFile(temporaryPath, source, { encoding: "utf8", mode: 0o644 });
  await rename(temporaryPath, settingsPath);
  return { settingsPath, addedEvents };
}
