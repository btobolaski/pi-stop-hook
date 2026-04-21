import { executeCommand } from "./executor.js";
import {
  DEFAULT_HOOK_TIMEOUT_S,
  type HookOutput,
  type PreStopHookConfig,
  type PreStopInput,
  type PreStopResult,
} from "./types.js";

/** Parse stdout JSON from a hook. Returns null on invalid JSON. */
function parseHookOutput(stdout: string): HookOutput | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as HookOutput;
  } catch {
    return null;
  }
}

/** Context needed to build the stdin payload. */
export interface PreStopContext {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  stopHookActive: boolean;
  lastAssistantMessage: string;
}

/**
 * Run all pre-stop hooks in parallel and aggregate results.
 *
 * Exit code semantics (matching Claude Code):
 * - 0: parse stdout as JSON for decision/reason/continue/etc.
 * - 2: blocking error — stop is prevented, stderr is the reason.
 * - Other: non-blocking error, logged but stop proceeds.
 * - null (timeout/spawn error): non-blocking error.
 */
export async function runPreStopHooks(
  hooks: PreStopHookConfig[],
  context: PreStopContext,
): Promise<PreStopResult> {
  const input: PreStopInput = {
    session_id: context.sessionId,
    transcript_path: context.transcriptPath,
    cwd: context.cwd,
    hook_event_name: "Stop",
    stop_hook_active: context.stopHookActive,
    last_assistant_message: context.lastAssistantMessage,
  };

  const stdinData = JSON.stringify(input);

  const results = await Promise.all(
    hooks.map(async (hook) => {
      const timeoutMs = (hook.timeout ?? DEFAULT_HOOK_TIMEOUT_S) * 1000;
      const result = await executeCommand(hook.command, stdinData, timeoutMs);
      return { hook, result };
    }),
  );

  const aggregated: PreStopResult = {
    shouldStop: true,
    blockReasons: [],
    errors: [],
    systemMessages: [],
    haltSession: false,
  };

  for (const { hook, result } of results) {
    if (result.exitCode === null) {
      aggregated.errors.push({ command: hook.command, error: result.stderr });
      continue;
    }

    if (result.exitCode === 2) {
      aggregated.shouldStop = false;
      const reason =
        result.stderr.trim() || `Hook "${hook.command}" exited with code 2`;
      aggregated.blockReasons.push(reason);
      continue;
    }

    if (result.exitCode !== 0) {
      aggregated.errors.push({
        command: hook.command,
        error:
          result.stderr.trim() ||
          `Hook exited with code ${result.exitCode}`,
      });
      continue;
    }

    const output = parseHookOutput(result.stdout);
    if (output === null) continue;

    if (output.decision === "block") {
      aggregated.shouldStop = false;
      aggregated.blockReasons.push(
        output.reason ?? `Hook "${hook.command}" blocked the stop`,
      );
    }

    if (output.continue === false) {
      aggregated.haltSession = true;
      if (output.stopReason) {
        aggregated.haltReason = output.stopReason;
      }
    }

    if (output.systemMessage) {
      aggregated.systemMessages.push(output.systemMessage);
    }
  }

  return aggregated;
}
