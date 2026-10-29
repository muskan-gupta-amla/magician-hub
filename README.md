# Magician Hub

Builds, PRs, review status, "where's my fix", standups, release notes and impact checks for the Magicians team, at http://localhost:4545. You get a popup when your builds start, pass or fail, when someone requests your review, and when your PR is approved or gets changes requested:

- **Windows popups**: on by default (`windowsPopups` in config).
- **Browser alerts**: click **Turn on browser alerts** in the sidebar and allow it once. Clicking an alert opens the build or PR. Keep the hub page open in a tab.

| View | Shows |
|---|---|
| Overview | What needs you, your open PRs (review status and checks), quick links (Jira, repos, Actions), team review health and latest builds |
| Ticket lookup (press `/`) | Everything about one ticket. **Lifecycle**: every Jira status it went through with the time spent in each (dev, code review, QA), lead time, the people it passed through, and a timeline of status moves, PRs opened, approvals and change requests, merges and deploys. **Which branches have it** (int, qat, hotfix), checked on GitHub: the fix commit is part of the branch, or a squashed down-merge mentions the ticket (whole history, not the last 100 commits). **Deployed to** DEV4, DEV10, INT, QA, HX: a successful deploy of the ticket's own branch, or of a branch that already had the fix, that rebuilt a service from a repo with the fix (`deployDays` of history). Then its PRs, builds and Jira details |
| Team PRs | Open team PRs with their real review status (each reviewer's latest decision; bots ignored) and filters. Drafts, POCs, PRs with no ticket key and inactive PRs go to **Parked**; **Hide** parks a PR for you only. **Copy list** (text for Teams) and **Download CSV** export what the filters show |
| Builds | **Environments**: the latest deploy on DEV4, DEV10, INT, QA and HX (`deployEnvs`, from the `Trigger - Z10 <ENV>` workflows in `deployRepo`), with the branch, the services it built (Admin, API, Webstore, Page builder, B Store…), who started it and pass/fail; you get a popup when your deploy finishes. Then the team's builds: every team deploy as a build (environment, the services it built, branch, pass/fail), plus real GitHub builds with the failed step and first error. Automatic PR checks (review bot, Stoplight lint, package updates; `checkWorkflows`) are hidden unless **Show: Also PR checks** is picked. A repo your GitHub login can't see is skipped |
| Branches | Stale team branches: no commit for `staleBranchDays` (30) and no open PR, never protected ones (int, qat, master, dev…, hotfix, release). Who created each one (the author of the first PR opened from it, else of its last commit), whether it is merged, and its PR. **Delete** is offered only to the person who created the branch, on their own PC and GitHub login, one branch at a time after a confirmation; the hub re-checks on GitHub first (same commit, no open PR, not protected). The list is cached for an hour and checked in batches |
| Daily Scrum | A **morning brief** (since yesterday, today's to-dos, blockers and your sprint). Your active sprints (days left, on track or behind, and your tickets in three tabs: **Open** = everything not Available For QA or Done, **AFQ**, **Done**), yesterday's numbers (PRs, reviews, hours, builds), then **Yesterday** (PRs, reviews, and what you did in Jira, one line per ticket: moved from → to, comments, assigned to, files added, created), **Today** (review comments to address, approved PRs to merge, reviews asked of you, tickets in progress) and **Blockers** (PRs with no reviewer or waiting 3+ days, failing builds, a sprint ending with your tickets open). **Copy for Teams** gives the text version |
| Release notes | Every ticket in the commits between two tags or branches, across all repos (squashed down-merges included). Copy as text |
| Time Log | Pick a period: This week, Last week, Last 7 days, Last 30 days or Custom (up to 92 days back); the totals, daily average, ring, day bars and logs follow it. **+ 30m Daily Scrum** (also **Log 30m scrum** on Daily Scrum) logs the scrum on the team's current stand-up ticket in one click, once a day (`scrumTicketJql`, `scrumTime`, `scrumComment`). Log time to Jira (ticket, time like 2h 30m, date, work type, comment; or the Log button on a ticket). A ticket with no Original Estimate shows **Add estimate**. A week ring against `weekHours`, a bar per day split by ticket with what is left to 8h, estimate vs logged on your open tickets, recent logs. A Friday reminder (`timeReminder`, default "Fri 16:00") pops up if the week is under `weekHours` |
| Impact check | For a PR link or a ticket with an open PR: a verdict and a checklist (approved, merge conflicts, checks, then each kind of risky change), and one row per risky change: new or removed procedure parameters, dropped or renamed columns, dropped tables/views, changed API routes, removed model properties, changed interface methods, removed frontend exports, removed config settings and text keys, deleted files, plus whether tests changed. Then where the other Znode repos use each one. It reads real changes only, so a ticket with no PR yet has nothing to check |

**Jira:** your open Jira tickets on the Overview (click one for its PRs and builds), Jira status next to every PR (amber when the ticket is Done but the PR is still open), Jira details on the ticket page, Jira summaries and status in release notes, and your in-progress tickets in the standup. On your PC it uses the Atlassian CLI and your own Jira login: install `acli` and run `acli jira auth login` once. On the team server it uses a read-only Jira account (`JIRA_EMAIL`, `JIRA_API_TOKEN`). `HUB_JIRA=off` turns it off.

**Full time logs on your PC:** the Atlassian CLI only returns a ticket's oldest 20 logs, so recent time on busy shared tickets (Meeting, Daily Stand-ups, Training, Holiday) is missing. The Time page then shows a box: create a personal Jira API token (link on the page), paste it, click **Connect**. The hub checks it with Jira, keeps it in your Windows profile (`%APPDATA%\MagicianHub\jira.json`, never in the repo), only sends it to Jira, and from then on reads Jira directly and counts every log. Delete that file to disconnect. The box is not available on the team server.

**Personal nudges** (popup + browser alert, only to the person concerned, each once a day):

| When | Who | Says |
|---|---|---|
| Daily 12:00 (`prNudgeTime`) | PR author | "Your PR admin #8398 was approved 17 days ago. Merge it" · "Changes requested on api #13745 3 days ago. Address them" · "Z10-40848 is Done in Jira but its PR … is still open" (more than 3 → one summary) |
| Weekdays 18:00 (`dayCheckTime`) | You (each team member on the team server) | "Today: 3h 30m logged · 4h 30m to go", only when under `dayHours` |
| Monday 10:00 (`staleNudgeTime`) | PR author | "You have 6 PRs with no activity for 30+ days. Close or update them", with the PRs |
| When it happens | Branch author | "webstore Z10-41122: build failed" (also started / passed) |

**More automatic nudges** (12:00, same popups): tickets of yours that haven't moved in code review or QA for `stuckDays` (3) days; your PRs merged into `branchBase` (int) `downMergeDays` (3)+ days ago whose change isn't on `downMergeTo` (qat) yet, once per PR. On Monday the stale-PR nudge also counts your stale branches.

**GitHub request limit:** GitHub allows 5,000 requests an hour per login. When fewer than `githubReserve` (500) are left, the hub keeps builds, PRs and popups going and pauses the extras (branch checks, filling the deploy history, estimates); if the limit is used up it says when it is back.

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
| `team` | Leave empty: until Jira is connected the hub shows only your own work (with a banner asking for your Jira API token), then it reads the team from Jira and daily after that (everyone with at least `teamMinTickets` tickets where `teamField` = `teamName` in the last `teamDays` days) and saves it in `%APPDATA%\MagicianHub\team.json`. `teamSync: false` keeps a list you type here |
| `trackBranches` | Branches checked by "Where's my fix" |
| `buildDays` | Builds from the last this many days are shown; bot runs are skipped (14) |
| `weekHours` | Hours a week the Time page and the Friday reminder measure against (40) |
| `dayHours`, `dayCheckTime` | Hours a day, and when to tell people under it (8, "18:00", weekdays) |
| `prNudgeTime`, `staleNudgeTime` | When PR nudges ("12:00") and the stale PR list ("Mon 10:00") go out |
| `timeReminder` | When to remind people under `weekHours` ("Fri 16:00", local time) |
| `teamField`, `teamName`, `teamDays`, `teamMinTickets` | How the team list is found in Jira (`cf[10117]`, `Magicians`, 90, 5) |
| `teamExclude` | People to leave out although they pick up Magicians tickets (they work for another team). Each entry is a fingerprint of the email, not the name: `node -e "console.log(require('crypto').createHash('sha256').update('first.last@amla.io').digest('hex').slice(0,16))"` |
| `staleDays` | Days without activity before a PR is parked (30) |
| `pollSeconds` | How often to check GitHub (60) |
| `windowsPopups` | `false` = browser alerts only |
| `ticketPrefixes` | Ticket keys release notes look for (`Z10`, `Z10LMC`, `KZI`, `KLRT`) |
| `jiraUrl` | Where ticket keys link to |
| `links` | Extra quick links on the Overview (Jira board, my open tickets) |
| `impactRepos` | Repos the impact check searches. Default = `repos` |
| `nudgeTimes` | When the Teams nudge posts (`10:00`, `16:00`, server time) |
