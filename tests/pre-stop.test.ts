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
      {
        command: `echo '{"decision":"block","reason":"tests are failing"}'`,
      },
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
    const hooks: PreStopHookConfig[] = [
      { command: "echo 'oops' >&2; exit 1" },
    ];
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
      { command: "echo '{}'" }, // allow
      {
        command: `echo '{"decision":"block","reason":"lint errors"}'`,
      }, // block
      { command: "true" }, // allow
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("lint errors");
  });

  it("collects multiple block reasons", async () => {
    const hooks: PreStopHookConfig[] = [
      {
        command: `echo '{"decision":"block","reason":"tests failing"}'`,
      },
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
      {
        command: `echo '{"continue":false,"stopReason":"Budget exceeded"}'`,
      },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.haltSession).toBe(true);
    expect(result.haltReason).toBe("Budget exceeded");
  });

  it("sets haltSession without haltReason when stopReason is absent", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"continue":false}'` },
    ];
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
      {
        command: `echo '{"decision":"block","reason":"not done","systemMessage":"heads up"}'`,
      },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(false);
    expect(result.blockReasons).toContain("not done");
    expect(result.systemMessages).toContain("heads up");
  });

  it("handles both decision=block and continue=false", async () => {
    const hooks: PreStopHookConfig[] = [
      {
        command: `echo '{"decision":"block","reason":"blocked","continue":false,"stopReason":"halt"}'`,
      },
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
      {
        command: `echo '{"systemMessage":"Warning: low disk space"}'`,
      },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.systemMessages).toContain("Warning: low disk space");
  });

  it("handles timeout as non-blocking error", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: "sleep 10", timeout: 0.2 },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("timed out");
  });

  // Pipes stdin to stderr via cat and uses exit 1 so the full JSON payload
  // appears in result.errors, letting us verify all fields and values.
  it("pipes correct JSON payload to hook stdin", async () => {
    const hooks: PreStopHookConfig[] = [{ command: "cat >&2; exit 1" }];
    const ctx = { ...baseContext, stopHookActive: true };
    const result = await runPreStopHooks(hooks, ctx);
    expect(result.errors).toHaveLength(1);
    const input = JSON.parse(result.errors[0]!.error) as Record<
      string,
      unknown
    >;
    expect(input.hook_event_name).toBe("Stop");
    expect(input.session_id).toBe("test-session-123");
    expect(input.transcript_path).toBe("/tmp/test-session.json");
    expect(input.cwd).toBe("/tmp/test");
    expect(input.stop_hook_active).toBe(true);
    expect(input.last_assistant_message).toBe("I have completed the task.");
    expect(Object.keys(input).sort()).toEqual([
      "cwd",
      "hook_event_name",
      "last_assistant_message",
      "session_id",
      "stop_hook_active",
      "transcript_path",
    ]);
  });

  it("ignores unrecognised decision values", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"decision":"allow"}'` },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
    expect(result.blockReasons).toHaveLength(0);
  });

  it("treats explicit continue=true as allow (does not halt)", async () => {
    const hooks: PreStopHookConfig[] = [
      { command: `echo '{"continue":true}'` },
    ];
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
    const hooks: PreStopHookConfig[] = [
      { command: "echo 'not json at all'" },
    ];
    const result = await runPreStopHooks(hooks, baseContext);
    expect(result.shouldStop).toBe(true);
  });

  it("runs hooks concurrently", async () => {
    // Two hooks that each sleep 200ms — if serial, total > 400ms
    const hooks: PreStopHookConfig[] = [
      { command: "sleep 0.2; echo '{}'" },
      { command: "sleep 0.2; echo '{}'" },
    ];
    const start = Date.now();
    const result = await runPreStopHooks(hooks, baseContext);
    const elapsed = Date.now() - start;
    expect(result.shouldStop).toBe(true);
    // Parallel: ~200ms. Serial: ~400ms+. 3x parallel headroom rejects serial.
    expect(elapsed).toBeLessThan(600);
  });
});
