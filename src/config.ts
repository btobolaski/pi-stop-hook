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
