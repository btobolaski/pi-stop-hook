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
    const result = await executeCommand(`echo '{"decision":"block","reason":"not ready"}'`, "");
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
    // bash -c handles "not found" via its own exit code (127);
    // this does NOT trigger the child.on("error") handler.
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
    // Generate ~2MB of output (well over the 1MB cap)
    const result = await executeCommand("dd if=/dev/zero bs=1024 count=2048 2>/dev/null", "");
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("exceeded");
  });

  it("handles EPIPE when child ignores stdin", async () => {
    // Send a large stdin payload to a command that doesn't read it
    const largeInput = "x".repeat(100_000);
    const result = await executeCommand("echo 'done'", largeInput);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("done");
  });
});
