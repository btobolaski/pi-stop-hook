# pi-stop-hook

A [pi coding agent](https://github.com/mariozechner/pi) extension that implements a PreStop hook, modeled after Claude
Code's `Stop` hook. When the agent finishes responding, the extension shells out to user-configured commands and
interprets exit codes and stdout JSON to decide whether to block the stop (keeping the agent working) or allow it.

## Installation

```bash
# Quick test
pi -e ./src/extension.ts

# Permanent (symlink into extensions directory)
ln -s /path/to/pi-stop-hook ~/.pi/agent/extensions/pi-stop-hook
```

When installed as a directory, pi discovers it via the `package.json` `pi.extensions` field.

## Configuration

Hooks are configured in JSON files. The extension checks two locations:

| Location                 | Scope                           |
| ------------------------ | ------------------------------- |
| `.pi/hooks.json`         | Project-local (relative to cwd) |
| `~/.pi/agent/hooks.json` | Global (all projects)           |

Both files are merged — project hooks run alongside global hooks, not replacing them.

### Config Format

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/my-hook.sh",
            "timeout": 30,
            "statusMessage": "Running pre-stop check..."
          }
        ]
      }
    ]
  }
}
```

Each hook entry supports:

| Field           | Type     | Default    | Description                                 |
| --------------- | -------- | ---------- | ------------------------------------------- |
| `command`       | `string` | _required_ | Shell command to execute via `/bin/bash -c` |
| `timeout`       | `number` | `600`      | Timeout in seconds                          |
| `statusMessage` | `string` | —          | Custom status message                       |

## Hook Protocol

### Stdin Input

Each hook receives a JSON payload on stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/session.json",
  "cwd": "/path/to/project",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "I have completed the task."
}
```

| Field                    | Description                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `session_id`             | Current session identifier                                                                                    |
| `transcript_path`        | Path to the session file                                                                                      |
| `cwd`                    | Working directory                                                                                             |
| `hook_event_name`        | Always `"Stop"`                                                                                               |
| `stop_hook_active`       | `true` if the agent is stopping after being kept alive by a previous hook run (use to prevent infinite loops) |
| `last_assistant_message` | Text content of the last assistant message                                                                    |

### Exit Codes

| Exit Code | Behavior                                                        |
| --------- | --------------------------------------------------------------- |
| **0**     | Parse stdout as JSON (see below). No JSON or `{}` = allow stop. |
| **2**     | Blocking error — stop is prevented. stderr is the block reason. |
| **Other** | Non-blocking error — logged as a warning, stop proceeds.        |

### Stdout JSON (Exit 0)

```json
{
  "decision": "block",
  "reason": "Tests are still failing",
  "continue": true,
  "stopReason": "Budget exceeded",
  "systemMessage": "Warning: approaching token limit"
}
```

| Field           | Type      | Description                                            |
| --------------- | --------- | ------------------------------------------------------ |
| `decision`      | `"block"` | Set to `"block"` to prevent the agent from stopping    |
| `reason`        | `string`  | Reason for blocking (shown to agent)                   |
| `continue`      | `boolean` | Set to `false` to halt the session entirely            |
| `stopReason`    | `string`  | Message shown to user when halting (`continue: false`) |
| `systemMessage` | `string`  | Warning message shown to user                          |

All fields are optional. An empty `{}` or no output means "allow stop."

## Behavior

- All hooks run **in parallel** (`Promise.all`) — group boundaries from the config file are flattened; if you need
  sequential ordering, use separate config files or a wrapper script
- If multiple hooks return conflicting decisions, **block takes precedence** over allow
- The `stop_hook_active` flag prevents infinite loops — when the agent stops again after being kept alive by a hook,
  this flag is `true` so scripts can detect re-entrancy
- When blocked, a follow-up message is sent to the agent with the block reason(s)
- When `continue: false`, the session is gracefully shut down via `ctx.shutdown()`

## Example Hook Scripts

### Run tests before allowing stop

```bash
#!/bin/bash
# .pi/hooks/check-tests.sh
input=$(cat)
active=$(echo "$input" | jq -r '.stop_hook_active')

# Don't loop — if we already ran tests, allow stop
if [ "$active" = "true" ]; then
  echo '{}'
  exit 0
fi

# Run tests
if npm test >/dev/null 2>&1; then
  echo '{}'
else
  echo '{"decision": "block", "reason": "Tests are failing. Please fix them before stopping."}'
fi
```

### Budget guard

```bash
#!/bin/bash
# Check token usage and halt if over budget
echo '{"continue": false, "stopReason": "Token budget exceeded"}'
```

## Development

```bash
pnpm install
pnpm test          # Run tests
pnpm typecheck     # Type check
```

## License

MIT
