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

        if (stdoutLimitExceeded) stdout = stdout ? `${stdout}\n[truncated]` : "[truncated]";
        if (stderrLimitExceeded) stderr = stderr ? `${stderr}\n[truncated]` : "[truncated]";
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
