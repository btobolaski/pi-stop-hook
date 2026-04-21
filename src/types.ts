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
