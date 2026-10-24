---
name: start
description: Open Magician Hub (http://localhost:4545), starting it in the background if it is not running. Pass "restart" after a plugin update.
disable-model-invocation: true
allowed-tools: Bash(node *launch.js*) PowerShell(node *launch.js*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.js"`, adding `--restart` if the arguments say restart: $ARGUMENTS

Report the one line it prints. If it says "did not start", show the log lines it printed and suggest `/magician-hub:setup`.
