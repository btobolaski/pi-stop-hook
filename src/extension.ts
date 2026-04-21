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
