---
name: setup
description: One-time setup for Magician Hub. Checks Node.js and Git, starts the hub, opens http://localhost:4545 and asks whether it should start with Windows. Safe to run again.
disable-model-invocation: true
allowed-tools: Bash(node *launch.js*) PowerShell(node *launch.js*)
---

Set up Magician Hub for the user. Be brief. Never ask for a token or password: the hub uses the user's existing Git login.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.js" --check` and show the result as a short table.
   - Node.js too old or missing, or Git missing: tell the user what to install (the line says where), and stop. They run `/magician-hub:setup` again afterwards.
   - Git email not set: show the command from the line and stop.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.js"`. It starts the hub in the background and opens the page. If it prints "did not start", show the log lines and stop.
3. Ask: "Start Magician Hub with Windows? (yes/no)". Yes: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.js" --autostart on`. No: skip.
4. Finish in a few lines:
   - Page: http://localhost:4545 (bookmark it). Pick your name at the top if it is not already chosen.
   - Popups: Windows popups are on; for browser alerts click **Turn on browser alerts** in the sidebar.
   - Jira: paste your Jira API token in the box at the top of the page ("Get a token" link there). It loads the Magicians team; until then the hub shows only your own work. The token stays on your PC.
   - Any time later: `/magician-hub:start` opens it (and starts it if it stopped). After a plugin update: `/magician-hub:start restart`.
