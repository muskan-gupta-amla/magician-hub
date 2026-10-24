# Magician Hub

Builds, PRs, review status, "where's my fix", standups, release notes and impact checks for the Magicians team, at http://localhost:4545. You get a popup when your builds start, pass or fail, when someone requests your review, and when your PR is approved or gets changes requested:

- **Windows popups**: on by default (`windowsPopups` in config).
- **Browser alerts**: click **Turn on browser alerts** in the sidebar and allow it once. Clicking an alert opens the build or PR. Keep the hub page open in a tab.

| View | Shows |
|---|---|
| Overview | What needs you, your open PRs (review status and checks), quick links (Jira, repos, Actions), team review health and latest builds |
| Ticket lookup (press `/`) | Everything about one ticket: its PRs with review status and checks, its builds, which branches have it (squashed down-merges included), Jira link and impact check |
| Team PRs | Open team PRs with their real review status (each reviewer's latest decision; bots ignored) and filters. Drafts, POCs, PRs with no ticket key and inactive PRs go to **Parked**; **Hide** parks a PR for you only |
| Builds | Team GitHub Actions runs, with the failed step and first error |
| Daily Scrum | A **morning brief** (since yesterday, today's to-dos, blockers, your sprint, and today's Outlook meetings with Join links; **Send to Teams** posts it to your chat). Your active sprints (your tickets done / in progress / to do, days left, on track or behind), yesterday's numbers (PRs, reviews, hours, builds), then **Yesterday** (PRs, reviews, tickets you moved, time logged), **Today** (review comments to address, approved PRs to merge, reviews asked of you, tickets in progress) and **Blockers** (PRs with no reviewer or waiting 3+ days, failing builds, a sprint ending with your tickets open). **Copy for Teams** gives the text version |
| Release notes | Every ticket in the commits between two tags or branches, across all repos (squashed down-merges included). Copy as text |
| Time Log | Log time to Jira (ticket, time like 2h 30m, date, work type, comment; or the Log button on a ticket). A ticket with no Original Estimate shows **Add estimate**. A week ring against `weekHours`, a bar per day split by ticket with what is left to 8h, estimate vs logged on your open tickets, recent logs. A Friday reminder (`timeReminder`, default "Fri 16:00") pops up if the week is under `weekHours` |
| Impact check | For a PR link or ticket: a verdict, a checklist and one row per risky change: new or removed procedure parameters, dropped or renamed columns, dropped tables/views, changed API routes, removed model properties, changed interface methods, removed frontend exports, removed config settings and text keys, deleted files, plus whether tests changed. Then where the other Znode repos use each one |

**Jira:** your open Jira tickets on the Overview (click one for its PRs and builds), Jira status next to every PR (amber when the ticket is Done but the PR is still open), Jira details on the ticket page, Jira summaries and status in release notes, and your in-progress tickets in the standup. On your PC it uses the Atlassian CLI and your own Jira login: install `acli` and run `acli jira auth login` once. On the team server it uses a read-only Jira account (`JIRA_EMAIL`, `JIRA_API_TOKEN`). `HUB_JIRA=off` turns it off.

**Full time logs on your PC:** the Atlassian CLI only returns a ticket's oldest 20 logs, so recent time on busy shared tickets (Meeting, Daily Stand-ups, Training, Holiday) is missing. The Time page then shows a box: create a personal Jira API token (link on the page), paste it, click **Connect**. The hub checks it with Jira, keeps it in your Windows profile (`%APPDATA%\MagicianHub\jira.json`, never in the repo), only sends it to Jira, and from then on reads Jira directly and counts every log. Delete that file to disconnect. The box is not available on the team server.

**Personal nudges** (popup + browser alert, only to the person concerned, each once a day):

| When | Who | Says |
|---|---|---|
| Daily 12:00 (`prNudgeTime`) | PR author | "Your PR admin #8398 was approved 17 days ago. Merge it" · "Changes requested on api #13745 3 days ago. Address them" · "Z10-40848 is Done in Jira but its PR … is still open" (more than 3 → one summary) |
| Weekdays 18:00 (`dayCheckTime`) | You (each team member on the team server) | "Today: 3h 30m logged · 4h 30m to go", only when under `dayHours` |
| Monday 10:00 (`staleNudgeTime`) | PR author | "You have 6 PRs with no activity for 30+ days. Close or update them", with the PRs |
| When it happens | Branch author | "webstore Z10-41122: build failed" (also started / passed) |

**Outlook and Teams in the morning brief (your PC, optional):** on Daily Scrum click **Connect Outlook** and paste your published calendar's ICS link (Outlook on the web > Settings > Calendar > Shared calendars > Publish a calendar, "Can view all details"). Click **Connect Teams** and paste a Workflows webhook link ("Post to a chat when a webhook request is received"). Both links stay in `%APPDATA%\MagicianHub\brief.json`. The hub doesn't read your Teams messages (that needs an app registered by IT).

**Teams nudge (optional, team server only):** set `TEAMS_WEBHOOK_URL` and the hub posts PRs that are ready to merge, have no reviewer, or have waited over 3 days, at each `nudgeTimes`.

## Get it (Claude Code plugin)

In a terminal:

```
claude plugin marketplace add muskan-gupta-amla/magician-hub
claude plugin install magician-hub@magicians-hub
```

Then in Claude Code run `/magician-hub:setup` once. It checks Node.js and Git, starts the hub in the background, opens http://localhost:4545 and asks whether to start it with Windows. Later, `/magician-hub:start` opens it (and starts it if it stopped). After `claude plugin update magician-hub`, run `/magician-hub:start restart`. The hub keeps running after Claude closes; its log is `%APPDATA%\MagicianHub\hub.log`.

## Get it without Claude (one click)

Download **Start Magician Hub.cmd** (posted in the Magicians Teams channel) and double-click it. It checks for Node.js and Git, downloads the hub into `%LOCALAPPDATA%\MagicianHub` the first time, updates it every later time, asks once whether to start with Windows, and opens the page. Keep its window open (minimised is fine); closing it stops the hub.

## Team server (one link for everyone)

Set `GITHUB_TOKEN` and the hub runs in hosted mode: one server for the whole team behind the company sign-in, each person sees their own view (or picks their name at the top right). Browser alerts work; Windows popups are local only. Setup steps for DevOps: [DEPLOY.md](DEPLOY.md).

## Setup by hand (on your own PC)

Needs Node.js 18+ and Git (and optionally the Atlassian CLI `acli` for Jira). No `npm install`, no token: the hub uses the GitHub login Git already has (Git Credential Manager), keeps it in memory and sends it only to api.github.com.

```powershell
node hub.js                # start; opens the page
node hub.js --test-popup   # check that Windows popups work
```

Tests (simulated GitHub and Jira): `node --test test/popups.test.js test/hosted.test.js test/tools.test.js test/jira-token.test.js` (also runs on every push via `.github/workflows/test.yml`) (add `SHOW_POPUPS=1` to see the popups).

To start with Windows, add a shortcut to `node "C:\path\to\magician-hub\hub.js"` in `shell:startup`.

## Settings (`config.json`)

| Key | Meaning |
|---|---|
| `repos`, `owner` | Repos to watch |
| `email` | Whose builds get popups. Empty = `git config user.email` |
| `team` | Leave empty: the hub reads the team from Jira shortly after it starts and daily after that (everyone with at least `teamMinTickets` tickets where `teamField` = `teamName` in the last `teamDays` days) and saves it in `%APPDATA%\MagicianHub\team.json`. Until Jira is connected, everyone's builds and PRs show. `teamSync: false` keeps a list you type here |
| `trackBranches` | Branches checked by "Where's my fix" |
| `buildDays` | Builds from the last this many days are shown; bot runs are skipped (14) |
| `weekHours` | Hours a week the Time page and the Friday reminder measure against (40) |
| `dayHours`, `dayCheckTime` | Hours a day, and when to tell people under it (8, "18:00", weekdays) |
| `prNudgeTime`, `staleNudgeTime` | When PR nudges ("12:00") and the stale PR list ("Mon 10:00") go out |
| `timeReminder` | When to remind people under `weekHours` ("Fri 16:00", local time) |
| `teamField`, `teamName`, `teamDays`, `teamMinTickets` | How the team list is found in Jira (`cf[10117]`, `Magicians`, 90, 5) |
| `staleDays` | Days without activity before a PR is parked (30) |
| `pollSeconds` | How often to check GitHub (60) |
| `windowsPopups` | `false` = browser alerts only |
| `ticketPrefixes` | Ticket keys release notes look for (`Z10`, `Z10LMC`, `KZI`, `KLRT`) |
| `jiraUrl` | Where ticket keys link to |
| `links` | Extra quick links on the Overview (Jira board, my open tickets) |
| `impactRepos` | Repos the impact check searches. Default = `repos` |
| `nudgeTimes` | When the Teams nudge posts (`10:00`, `16:00`, server time) |
