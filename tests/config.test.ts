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
      Stop: [
        {
          hooks: commands.map((command) => ({ type: "command", command })),
        },
      ],
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
              {
                type: "command",
                command: "npm test",
                statusMessage: "Running tests...",
              },
            ],
          },
        ],
      },
    };
    const hooks = extractHooks(file);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toEqual({ command: "my-script.sh", timeout: 30 });
    expect(hooks[1]).toEqual({
      command: "npm test",
      statusMessage: "Running tests...",
    });
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
      hooks: {
        Stop: [{ hooks: [{ command: "no-type.sh" }] }],
      },
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
          {
            hooks: [
              {
                type: "command",
                command: "test.sh",
                timeout: "30" as unknown as number,
              },
            ],
          },
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
        Stop: [{} as { hooks: [] }, { hooks: [{ type: "command", command: "valid.sh" }] }],
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
    const result = await loadHooksConfig(tempDir, {
      globalPath: nonexistentGlobal,
    });
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("loads project hooks only when no global config exists", async () => {
    const piDir = join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "hooks.json"), makeHooksJson(["project.sh"]));

    const result = await loadHooksConfig(tempDir, {
      globalPath: nonexistentGlobal,
    });
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
