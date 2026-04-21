Both file-writing tools require interactive approval which isn't available in this subagent context. Here are the **complete file contents**, clearly labeled, for the parent session to use:

---

# Research: pi-stop-hook Source & Test Files

## Summary

`pi-stop-hook` is a `pi` coding-agent extension that intercepts the `agent_end` event and runs user-configured shell hooks before the agent stops. Hooks can block the stop (sending a follow-up message back to the agent), halt the session entirely, or allow it. All hooks run in parallel; a 1 MB output cap and configurable timeout prevent runaway hooks from hanging the agent.

---

## Complete File Contents

---

### `package.json`

```json
{
  "name": "pi-stop-hook",
  "version": "0.1.0",
  "description": "PreStop hook extension for pi coding agent",
  "type": "module",
  "pi": {
    "extensions": ["./src/extension.ts"]
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

---

### `src/types.ts`

```typescript
/** Default hook timeout in seconds. */
export const DEFAULT_HOOK_TIMEOUT_S = 600;

/** Hook configuration from the user's hooks.json file. */
export interface PreStopHookConfig {
  /** Shell command to execute. */
  command: string;
  /** Timeout in seconds. Default: 600 */
  timeout?: number;
  /** Custom spinner/status message. */
  statusMessage?: string;
}

/** JSON payload piped to the hook's stdin. */
export interface PreStopInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/** JSON the hook can return on stdout (exit 0 only). */
export interface HookOutput {
  /** Set to "block" to prevent the agent from stopping. */
  decision?: "block";
  /** Reason for blocking (shown to agent when blocking). */
  reason?: string;
  /** Set to false to halt the session entirely. */
  continue?: boolean;
  /** Message for user when continue=false. */
  stopReason?: string;
  /** Warning message shown to user. */
  systemMessage?: string;
}

/** Raw result from executing a single hook command. */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Aggregated result from running all pre-stop hooks. */
export interface PreStopResult {
  /** true = proceed with stop, false = blocked by a hook. */
  shouldStop: boolean;
  /** Reasons from hooks that blocked the stop. */
  blockReasons: string[];
  /** Non-blocking errors from hooks that failed. */
  errors: Array<{ command: string; error: string }>;
  /** Warning messages to surface to the user. */
  systemMessages: string[];
  /** true if any hook set continue=false. */
  haltSession: boolean;
  /** stopReason from the halting hook. */
  haltReason?: string;
}
```

---

### `src/executor.ts`

```typescript
import { spawn } from "node:child_process";
import { DEFAULT_HOOK_TIMEOUT_S, type CommandResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = DEFAULT_HOOK_TIMEOUT_S * 1000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB per stream

/**
 * Execute a shell command via `/bin/bash -c`, piping `stdinData` to stdin.
 * Returns the exit code, stdout, and stderr.
 *
 * Output is capped at 1 MB per stream to prevent OOM from runaway hooks.
 */
export function executeCommand(
  command: string,
  stdinData: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    function settle(result: CommandResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    const child = spawn("/bin/bash", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: ac.signal,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLimitExceeded = false;
    let stderrLimitExceeded = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
      } else if (!stdoutLimitExceeded) {
        stdoutLimitExceeded = true;
        child.kill();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
      } else if (!stderrLimitExceeded) {
        stderrLimitExceeded = true;
        child.kill();
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const partialStdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const partialStderr = Buffer.concat(stderrChunks).toString("utf-8");
      const errorMsg =
        err.code === "ABORT_ERR"
          ? `Hook timed out after ${timeoutMs}ms`
          : err.message;
      settle({
        exitCode: null,
        stdout: partialStdout,
        stderr: partialStderr ? `${partialStderr}\n${errorMsg}` : errorMsg,
      });
    });

    child.on("close", (code) => {
      let stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      let stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (stdoutLimitExceeded || stderrLimitExceeded) {
        const exceededStreams = [
          stdoutLimitExceeded && "stdout",
          stderrLimitExceeded && "stderr",
        ]
          .filter(Boolean)
          .join(" and ");
        const limitMsg = `Hook ${exceededStreams} exceeded ${MAX_OUTPUT_BYTES} bytes limit`;

        if (stdoutLimitExceeded) stdout += "\n[truncated]";
        if (stderrLimitExceeded) stderr += "\n[truncated]";
        stderr = stderr ? `${stderr}\n${limitMsg}` : limitMsg;

        settle({ exitCode: null, stdout, stderr });
        return;
      }

      settle({ exitCode: code, stdout, stderr });
    });

    // EPIPE is expected if the child exits before consuming all stdin
    child.stdin.on("error", () => {});
    child.stdin.end(stdinData);
  });
}
```

---

### `src/config.ts`

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PreStopHookConfig } from "./types.js";

/**
 * Shape of the hooks.json configuration file, following Claude Code's structure.
 *
 * ```json
 * {
 *   "hooks": {
 *     "Stop": [
 *       {
 *         "hooks": [
 *           { "type": "command", "command": "my-script.sh", "timeout": 30 }
 *         ]
 *       }
 *     ]
 *   }
 * }
 * ```
 */
interface HooksFile {
  hooks?: {
    Stop?: Array<{
      hooks?: Array<{
        type?: string;
        command?: string;
        timeout?: number;
        statusMessage?: string;
      }>;
    }>;
  };
}

export interface HooksResult {
  hooks: PreStopHookConfig[];
  warnings: string[];
}

/** Read and parse a single hooks.json file. Returns hooks and any warnings. */
async function readHooksFile(path: string): Promise<HooksResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { hooks: [], warnings: [] };
  }

  let parsed: HooksFile;
  try {
    parsed = JSON.parse(raw) as HooksFile;
  } catch {
    return {
      hooks: [],
      warnings: [`Failed to parse ${path}: invalid JSON`],
    };
  }

  return { hooks: extractHooks(parsed), warnings: [] };
}

/** Extract PreStopHookConfig[] from a parsed hooks file. */
function extractHooks(file: HooksFile): PreStopHookConfig[] {
  const stopGroups = file?.hooks?.Stop;
  if (!Array.isArray(stopGroups)) return [];

  const configs: PreStopHookConfig[] = [];

  for (const group of stopGroups) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const hook of group.hooks) {
      if (hook?.type !== undefined && hook.type !== "command") continue;
      if (typeof hook?.command !== "string" || hook.command.trim() === "") {
        continue;
      }
      configs.push({
        command: hook.command,
        ...(typeof hook.timeout === "number" &&
          Number.isFinite(hook.timeout) &&
          hook.timeout > 0 && { timeout: hook.timeout }),
        ...(typeof hook.statusMessage === "string" && {
          statusMessage: hook.statusMessage,
        }),
      });
    }
  }

  return configs;
}

/** Path to the project-level hooks config. */
export function projectHooksPath(cwd: string): string {
  return join(cwd, ".pi", "hooks.json");
}

/** Path to the global hooks config. */
export function globalHooksPath(): string {
  return join(homedir(), ".pi", "agent", "hooks.json");
}

/**
 * Load and merge hook configs from project and global locations.
 * Global hooks run first, then project hooks. Both sets are merged (not replaced).
 */
export async function loadHooksConfig(
  cwd: string,
  options?: { globalPath?: string },
): Promise<HooksResult> {
  const gPath = options?.globalPath ?? globalHooksPath();
  const [projectResult, globalResult] = await Promise.all([
    readHooksFile(projectHooksPath(cwd)),
    readHooksFile(gPath),
  ]);

  return {
    hooks: [...globalResult.hooks, ...projectResult.hooks],
    warnings: [...globalResult.warnings, ...projectResult.warnings],
  };
}

export { readHooksFile, extractHooks };
export type { HooksFile };
```

---

### `src/pre-stop.ts`

```typescript
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
```

---

### `src/extension.ts`

```typescript
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { loadHooksConfig } from "./config.js";
import { runPreStopHooks } from "./pre-stop.js";

// Local type guards for assistant messages. The pi API's AgentMessage union
// references @mariozechner/pi-agent-core and @mariozechner/pi-ai which aren't
// separately installable, so we cast through unknown and match on runtime shape.
interface TextBlock {
  type: "text";
  text: string;
}

interface AssistantMsg {
  role: "assistant";
  content: Array<TextBlock | { type: string }>;
}

export function isAssistantMessage(m: unknown): m is AssistantMsg {
  if (m == null || typeof m !== "object") return false;
  const msg = m as { role?: string; content?: unknown };
  return msg.role === "assistant" && Array.isArray(msg.content);
}

export function getTextContent(message: AssistantMsg): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function preStopHookExtension(pi: ExtensionAPI): void {
  // Reset per session to avoid leaking state across sessions
  let stopHookActive = false;
  pi.on("session_start", () => {
    stopHookActive = false;
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    try {
      await handleAgentEnd(pi, event, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`pre-stop-hook error: ${msg}`, "error");
    }
  });

  async function handleAgentEnd(
    pi: ExtensionAPI,
    event: AgentEndEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const { hooks, warnings } = await loadHooksConfig(ctx.cwd);
    for (const warning of warnings) {
      ctx.ui.notify(warning, "error");
    }
    if (hooks.length === 0) return;

    const statusKey = "pre-stop-hook";
    // First hook's statusMessage wins; fall back to generic message
    const statusMsg = hooks
      .map((h) => h.statusMessage)
      .find((s) => s !== undefined);
    ctx.ui.setStatus(statusKey, statusMsg ?? "Running pre-stop hooks...");

    // Spread to avoid mutating event.messages; cast because AgentMessage
    // union types reference packages that aren't separately installable.
    const lastAssistant = ([...event.messages] as unknown[])
      .reverse()
      .find(isAssistantMessage);
    const lastAssistantMessage = lastAssistant
      ? getTextContent(lastAssistant)
      : "";

    const sessionFile = ctx.sessionManager.getSessionFile() ?? "";

    const result = await runPreStopHooks(hooks, {
      sessionId: ctx.sessionManager.getSessionId(),
      transcriptPath: sessionFile,
      cwd: ctx.cwd,
      stopHookActive,
      lastAssistantMessage,
    });

    ctx.ui.setStatus(statusKey, undefined);

    for (const msg of result.systemMessages) {
      ctx.ui.notify(msg, "info");
    }

    for (const err of result.errors) {
      ctx.ui.notify(`Hook error (${err.command}): ${err.error}`, "error");
    }

    if (result.haltSession) {
      if (result.haltReason) {
        ctx.ui.notify(result.haltReason, "info");
      }
      ctx.shutdown();
      return;
    }

    if (!result.shouldStop) {
      stopHookActive = true;
      const reason = result.blockReasons.join("\n\n");
      pi.sendMessage(
        {
          customType: "pre-stop-hook",
          content: `A pre-stop hook has prevented you from stopping. Reason:\n\n${reason}\n\nPlease address the above and continue working.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else {
      stopHookActive = false;
    }
  }
}
```

---

### `tests/executor.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { executeCommand } from "../src/executor.js";

describe("executeCommand", () => {
  it("returns exit 0 with stdout", async () => {
    const result = await executeCommand("echo 'hello world'", "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.stderr).toBe("");
  });

  it("returns exit code for failing commands", async () => {
    const result = await executeCommand("exit 1", "");
    expect(result.exitCode).toBe(1);
  });

  it("returns exit 2 with stderr", async () => {
    const result = await executeCommand("echo 'block reason' >&2; exit 2", "");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim()).toBe("block reason");
  });

  it("pipes stdin data to the command", async () => {
    const input = JSON.stringify({ hook_event_name: "Stop" });
    const result = await executeCommand("cat", input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(input);
  });

  it("captures JSON stdout", async () => {
    const result = await executeCommand(
      `echo '{"decision":"block","reason":"not ready"}'`, "",
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toBe("not ready");
  });

  it("times out long-running commands", async () => {
    const result = await executeCommand("sleep 10", "", 200);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out");
  });

  it("handles commands that produce no output", async () => {
    const result = await executeCommand("true", "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("handles both stdout and stderr simultaneously", async () => {
    const result = await executeCommand("echo 'out'; echo 'err' >&2", "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("returns 127 when bash cannot find the command", async () => {
    const result = await executeCommand("/nonexistent/binary-xyz-abc-12345", "");
    expect(result.exitCode).toBe(127);
  });

  it("preserves partial stderr before timeout message", async () => {
    const result = await executeCommand("echo 'partial' >&2; sleep 10", "", 300);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("partial");
    expect(result.stderr).toContain("timed out");
  });

  it("kills child and returns error when output exceeds byte limit", async () => {
    const result = await executeCommand(
      "dd if=/dev/zero bs=1024 count=2048 2>/dev/null", "",
    );
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("exceeded");
  });

  it("handles EPIPE when child ignores stdin", async () => {
    const largeInput = "x".repeat(100_000);
    const result = await executeCommand("echo 'done'", largeInput);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("done");
  });
});
```

---

### `tests/pre-stop.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { runPreStopHooks, type PreStopContext } from "../src/pre-stop.js";
import type { PreStopHookConfig } from "../src/types.js";

const baseContext: PreStopContext = {
  sessionId: "test-session-123",
  transcriptPath: "/tmp/test-session.json",
  cwd: "/tmp/test",
  stopHookActive: false,
  lastAssistantMessage: "I have completed the task.",
};

describe("runPreStopHooks", () => {
  it("returns safe defaults for empty hooks array", async () => {
    const result = await runPreStopHooks([], baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.blockReasons).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.systemMessages).toHaveLength(0);
    expect(result.haltSession).toBe(false);
    expect(result.haltReason).toBeUndefined();
  });

  it("allows stop when hook exits 0 with no output", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "true" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.blockReasons).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("allows stop when hook exits 0 with empty stdout", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "echo -n ''" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
  });

  it("allows stop when hook exits 0 with JSON lacking decision/continue", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "echo '{}'" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
  });

  it("blocks stop when hook returns decision=block", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"decision":"block","reason":"tests are failing"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("tests are failing");
  });

  it("blocks stop when hook exits with code 2", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: "echo 'not ready yet' >&2; exit 2" },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("not ready yet");
  });

  it("uses fallback reason when exit 2 produces no stderr", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "exit 2" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toHaveLength(1);
    expect(result.blockReasons[0]).toMatch(/exited with code 2/);
  });

  it("treats non-0/non-2 exit codes as non-blocking errors", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "echo 'oops' >&2; exit 1" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.command).toBe("echo 'oops' >&2; exit 1");
    expect(result.errors[0]!.error).toBe("oops");
  });

  it("uses fallback error message when non-0/non-2 exit has no stderr", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "exit 3" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toMatch(/exited with code 3/);
  });

  it("handles multiple hooks in parallel — block wins", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: "echo '{}'" },
      { command: `echo '{"decision":"block","reason":"lint errors"}'` },
      { command: "true" },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("lint errors");
  });

  it("collects multiple block reasons", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"decision":"block","reason":"tests failing"}'` },
      { command: "echo 'lint errors' >&2; exit 2" },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toHaveLength(2);
    expect(result.blockReasons).toContain("tests failing");
    expect(result.blockReasons).toContain("lint errors");
  });

  it("handles continue=false to halt session", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"continue":false,"stopReason":"Budget exceeded"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.haltSession).toBe(true);
    expect(result.haltReason).toBe("Budget exceeded");
  });

  it("sets haltSession without haltReason when stopReason is absent", async () => {
    const hooks: PreStopHookConfig[] = [{ command: `echo '{"continue":false}'` }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.haltSession).toBe(true);
    expect(result.haltReason).toBeUndefined();
  });

  it("uses fallback reason when decision=block has no reason field", async () => {
    const cmd = `echo '{"decision":"block"}'`;
    const hooks: PreStopHookConfig[] = [{ command: cmd }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toHaveLength(1);
    expect(result.blockReasons[0]).toContain("blocked the stop");
  });

  it("handles both decision=block and systemMessage simultaneously", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"decision":"block","reason":"not done","systemMessage":"heads up"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("not done");
    expect(result.systemMessages).toContain("heads up");
  });

  it("handles both decision=block and continue=false", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"decision":"block","reason":"blocked","continue":false,"stopReason":"halt"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("blocked");
    expect(result.haltSession).toBe(true);
    expect(result.haltReason).toBe("halt");
  });

  it("collects multiple systemMessages from different hooks", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"systemMessage":"msg1"}'` },
      { command: `echo '{"systemMessage":"msg2"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.systemMessages).toHaveLength(2);
    expect(result.systemMessages).toContain("msg1");
    expect(result.systemMessages).toContain("msg2");
  });

  it("surfaces system messages", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"systemMessage":"Warning: low disk space"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.systemMessages).toContain("Warning: low disk space");
  });

  it("handles timeout as non-blocking error", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "sleep 10", timeout: 0.2 }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("timed out");
  });

  it("passes correct JSON input to hooks via stdin", async () => {
    const hooks: PreStopHookConfig[] = [
      {
        command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stderr.write(j.hook_event_name);process.exit(1)})"`,
      },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBe("Stop");
  });

  it("passes stop_hook_active flag in input", async () => {
    const hooks: PreStopHookConfig[] = [
      {
        command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stderr.write(String(j.stop_hook_active));process.exit(1)})"`,
      },
    ];
    const result = await runPreStopHooks(hooks, { ...baseContext, stopHookActive: true });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBe("true");
  });

  it("passes all expected fields in stdin JSON", async () => {
    const hooks: PreStopHookConfig[] = [
      {
        command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const keys=Object.keys(j).sort().join(',');process.stderr.write(keys);process.exit(1)})"`,
      },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBe(
      "cwd,hook_event_name,last_assistant_message,session_id,stop_hook_active,transcript_path",
    );
  });

  it("ignores unrecognised decision values", async () => {
    const hooks: PreStopHookConfig[] = [{ command: `echo '{"decision":"allow"}'` }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.blockReasons).toHaveLength(0);
  });

  it("treats explicit continue=true as allow (does not halt)", async () => {
    const hooks: PreStopHookConfig[] = [{ command: `echo '{"continue":true}'` }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.haltSession).toBe(false);
  });

  it("ignores stderr when hook exits 0 with valid JSON stdout", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{}'; echo 'ignored warning' >&2` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.systemMessages).toHaveLength(0);
  });

  it("handles invalid JSON stdout on exit 0 as allow", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "echo 'not json at all'" }];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
  });

  it("runs hooks concurrently", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: "sleep 0.2; echo '{}'" },
      { command: "sleep 0.2; echo '{}'" },
    ];
    const start = Date.now();
    const result = await runPreStopHooks(hooks, baseContext);
    const elapsed = Date.now() - start;
    expect(result.shouldStop).toBe(true);
    expect(elapsed).toBeLessThan(600);
  });
});
```

---

### `tests/config.test.ts`

```typescript
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractHooks,
  readHooksFile,
  loadHooksConfig,
  projectHooksPath,
  globalHooksPath,
  type HooksFile,
} from "../src/config.js";

function makeHooksJson(commands: string[]): string {
  return JSON.stringify({
    hooks: {
      Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }],
    },
  });
}

describe("extractHooks", () => {
  it("returns empty array when hooks.Stop key is absent", () => {
    expect(extractHooks({} as HooksFile)).toEqual([]);
    expect(extractHooks({ hooks: {} } as HooksFile)).toEqual([]);
  });

  it("returns empty array when Stop group is empty", () => {
    const file: HooksFile = { hooks: { Stop: [] } };
    expect(extractHooks(file)).toEqual([]);
  });

  it("extracts hooks from valid config", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "my-script.sh", timeout: 30 },
              { type: "command", command: "npm test", statusMessage: "Running tests..." },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toEqual({ command: "my-script.sh", timeout: 30 });
    expect(hooks[1]).toEqual({ command: "npm test", statusMessage: "Running tests..." });
  });

  it("skips hooks without a command", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command" },
              { type: "command", command: "" },
              { type: "command", command: "valid.sh" },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toBe("valid.sh");
  });

  it("handles multiple matcher groups", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "first.sh" }] },
          { hooks: [{ type: "command", command: "second.sh" }] },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(2);
  });

  it("skips hooks with non-command type", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "webhook", command: "https://example.com" },
              { type: "command", command: "valid.sh" },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toBe("valid.sh");
  });

  it("includes hooks with no type field (defaults to command)", () => {
    const file: HooksFile = {
      hooks: { Stop: [{ hooks: [{ command: "no-type.sh" }] }] },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(1);
  });

  it("skips hooks with whitespace-only command", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "   " },
              { type: "command", command: "valid.sh" },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(1);
  });

  it("ignores non-number timeout values", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "test.sh", timeout: "30" as unknown as number }] },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.timeout).toBeUndefined();
  });

  it("ignores Infinity and NaN timeout values", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "a.sh", timeout: Infinity },
              { type: "command", command: "b.sh", timeout: NaN },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.timeout).toBeUndefined();
    expect(hooks[1]!.timeout).toBeUndefined();
  });

  it("ignores zero and negative timeout values", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "a.sh", timeout: 0 },
              { type: "command", command: "b.sh", timeout: -5 },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.timeout).toBeUndefined();
    expect(hooks[1]!.timeout).toBeUndefined();
  });

  it("skips groups with missing hooks array", () => {
    const file: HooksFile = {
      hooks: {
        Stop: [
          {} as { hooks: [] },
          { hooks: [{ type: "command", command: "valid.sh" }] },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(1);
  });
});

describe("readHooksFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-hooks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty for missing file with no warnings", async () => {
    const result = await readHooksFile(join(tempDir, "nonexistent.json"));
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns warning for malformed JSON", async () => {
    const path = join(tempDir, "hooks.json");
    await writeFile(path, "not json {{{");
    const result = await readHooksFile(path);
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid JSON");
  });

  it("reads valid hooks file", async () => {
    const path = join(tempDir, "hooks.json");
    await writeFile(path, makeHooksJson(["test.sh"]));
    const result = await readHooksFile(path);
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]!.command).toBe("test.sh");
    expect(result.warnings).toEqual([]);
  });

  it("returns empty for valid JSON without hooks key and no warnings", async () => {
    const path = join(tempDir, "hooks.json");
    await writeFile(path, JSON.stringify({ something: "else" }));
    const result = await readHooksFile(path);
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("loadHooksConfig", () => {
  let tempDir: string;
  let nonexistentGlobal: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-hooks-load-"));
    nonexistentGlobal = join(tempDir, "no-global", "hooks.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty hooks when no config files exist", async () => {
    const result = await loadHooksConfig(tempDir, { globalPath: nonexistentGlobal });
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("loads project hooks only when no global config exists", async () => {
    const piDir = join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "hooks.json"), makeHooksJson(["project.sh"]));
    const result = await loadHooksConfig(tempDir, { globalPath: nonexistentGlobal });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]!.command).toBe("project.sh");
  });

  it("loads global hooks only when no project config exists", async () => {
    const globalDir = join(tempDir, "global");
    await mkdir(globalDir, { recursive: true });
    const globalPath = join(globalDir, "hooks.json");
    await writeFile(globalPath, makeHooksJson(["global.sh"]));
    const result = await loadHooksConfig(tempDir, { globalPath });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]!.command).toBe("global.sh");
  });

  it("merges global hooks before project hooks", async () => {
    const piDir = join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "hooks.json"), makeHooksJson(["project.sh"]));
    const globalDir = join(tempDir, "global");
    await mkdir(globalDir, { recursive: true });
    const globalPath = join(globalDir, "hooks.json");
    await writeFile(globalPath, makeHooksJson(["global.sh"]));
    const result = await loadHooksConfig(tempDir, { globalPath });
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0]!.command).toBe("global.sh");
    expect(result.hooks[1]!.command).toBe("project.sh");
  });

  it("collects warnings from both sources", async () => {
    const piDir = join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "hooks.json"), "bad json {{{");
    const globalDir = join(tempDir, "global");
    await mkdir(globalDir, { recursive: true });
    const globalPath = join(globalDir, "hooks.json");
    await writeFile(globalPath, "also bad {{{");
    const result = await loadHooksConfig(tempDir, { globalPath });
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });
});

describe("path helpers", () => {
  it("projectHooksPath returns correct path", () => {
    expect(projectHooksPath("/my/project")).toBe("/my/project/.pi/hooks.json");
  });

  it("globalHooksPath returns path under home directory", () => {
    const path = globalHooksPath();
    expect(path).toContain(".pi/agent/hooks.json");
  });
});
```

---

### `tests/extension-helpers.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { isAssistantMessage, getTextContent } from "../src/extension.js";

describe("isAssistantMessage", () => {
  it("returns true for assistant messages with content array", () => {
    expect(isAssistantMessage({ role: "assistant", content: [] })).toBe(true);
  });

  it("returns true for assistant messages with text blocks", () => {
    expect(
      isAssistantMessage({ role: "assistant", content: [{ type: "text", text: "Hello" }] }),
    ).toBe(true);
  });

  it("returns false for user messages", () => {
    expect(isAssistantMessage({ role: "user", content: [] })).toBe(false);
  });

  it("returns false when content is not an array", () => {
    expect(isAssistantMessage({ role: "assistant", content: "text" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAssistantMessage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAssistantMessage(undefined)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isAssistantMessage("string")).toBe(false);
    expect(isAssistantMessage(42)).toBe(false);
  });

  it("returns false when content property is absent", () => {
    expect(isAssistantMessage({ role: "assistant" })).toBe(false);
  });
});

describe("getTextContent", () => {
  it("extracts text from a single text block", () => {
    const msg = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Hello" }],
    };
    expect(getTextContent(msg)).toBe("Hello");
  });

  it("joins multiple text blocks with newline", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Hello" },
        { type: "text" as const, text: "World" },
      ],
    };
    expect(getTextContent(msg)).toBe("Hello\nWorld");
  });

  it("filters out non-text blocks", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "tool_use" },
        { type: "text" as const, text: "Result" },
        { type: "thinking" },
      ],
    };
    expect(getTextContent(msg)).toBe("Result");
  });

  it("returns empty string when content has no text blocks", () => {
    const msg = { role: "assistant" as const, content: [{ type: "tool_use" }] };
    expect(getTextContent(msg)).toBe("");
  });

  it("returns empty string for empty content array", () => {
    const msg = { role: "assistant" as const, content: [] as Array<{ type: string }> };
    expect(getTextContent(msg)).toBe("");
  });
});
```

---

## Findings

1. **Project structure** — ESM-only TypeScript (`"type": "module"`), Vitest for testing, no build step. `pi` loads `./src/extension.ts` directly via the `pi.extensions` field in `package.json`.

2. **Entry point** — `src/extension.ts` default-exports `preStopHookExtension(pi: ExtensionAPI)`, registers `session_start` + `agent_end` listeners. `agent_end` orchestrates config load → hook execution → result dispatch.

3. **Exit-code semantics** (mirrors Claude Code):
   - Exit `0` → parse stdout JSON; `decision:"block"` blocks, `continue:false` halts, `systemMessage` surfaced as info.
   - Exit `2` → blocking; stderr is the block reason injected back to the agent.
   - Other exit / `null` (timeout/output-exceeded) → non-blocking error, logged, stop proceeds.

4. **Safety limits** (`executor.ts`) — 1 MB cap per stream kills the child and returns `exitCode: null`. AbortController timeout also returns `exitCode: null`. EPIPE on stdin silently ignored.

5. **Config loading** (`config.ts`) — Reads `{cwd}/.pi/hooks.json` (project) and `~/.pi/agent/hooks.json` (global) in parallel. Global hooks prepend project hooks. Missing files: silent. Malformed JSON: warning notification.

6. **Concurrency** — `Promise.all` across all hooks. Test confirms two 200ms-sleep hooks finish in <600ms.

7. **`stopHookActive` flag** — Per-session re-entry guard; reset on `session_start`. Passed in stdin JSON so scripts can detect loops.

8. **Test coverage** — 12 executor tests, ~30 pre-stop tests, ~25 config tests, 13 extension-helper tests (~80 total). All integration-style (real child processes, real FS).

## Sources

- All files read directly from `/Users/brendan/src/pi-stop-hook/` — primary source, no external lookups needed.

## Gaps

- `tsconfig.json` not examined — compiler strictness unknown.
- `@mariozechner/pi-coding-agent` peer dep not installed — `ExtensionAPI`, `AgentEndEvent`, `ExtensionContext` types opaque.
- No `vitest.config.*` examined — test runner config not captured.