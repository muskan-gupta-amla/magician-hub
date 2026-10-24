# Hosting Magician Hub for the team

Goal: one link the Magicians team opens (also pinned as a Teams tab). No install for anyone.
The hub is one Node.js process with no dependencies. With `GITHUB_TOKEN` set it runs in **hosted mode**: one server polls GitHub for the whole team, and each person sees their own view after signing in.

## What DevOps needs to set up

### 1. Read-only GitHub access for the hub
- A **fine-grained token** owned by a service (machine) account that is a member of `MRRSoft`, not a person's account.
- Resource owner `MRRSoft`; repositories: `znode-webstore10x-page-builder`, `znode10-admin-migration`, `znode10-api-migration`, `znode10-multifront-db`.
- Repository permissions, all **Read-only**: Actions, Pull requests, Contents, Metadata.
- MRRSoft may need to approve fine-grained tokens. Set an expiry and a reminder to rotate it.
- Usage: about 1,200 GitHub requests per hour for the whole team, within the 5,000/hour limit. The impact check also uses GitHub code search (10 searches a minute); results are cached for an hour.

### 2. A small host
- **Azure App Service** (Linux, Node.js 20 LTS or newer; the smallest Basic plan is enough). An internal VM with Node.js 18+ also works.
- Deploy the repo files as they are. Startup command: `node hub.js`. No build step and no `npm install`.
- App settings:
  | Setting | Value |
  |---|---|
  | `GITHUB_TOKEN` | the token from step 1, ideally as a Key Vault reference |
  | `PORT` | set automatically by App Service; on a VM pick one |
  | `TZ` | `Asia/Kolkata`, so the Teams nudge posts at local times |
  | `JIRA_EMAIL`, `JIRA_API_TOKEN` | optional: a **read-only** Jira account (browse access to the Z10 project) and its API token, for Jira tickets and status. Leave empty for no Jira |
  | `TEAMS_WEBHOOK_URL` | optional: a Teams **Workflows** webhook for the Magicians channel ("Post to a channel when a webhook request is received"). Leave empty for no Teams posts |
- **One instance only**: the hub keeps its data in memory, so scaling out would run duplicate polls.
- **Always On**: enabled, so it keeps checking GitHub when nobody has the page open.
- Health check path: `/health` (returns `ok`, no data).
- Outbound HTTPS to `api.github.com` must be allowed.

### 3. Company sign-in (required)
The hub shows private repo data (PR titles, branch names), so it must only open for the team.
- App Service → **Authentication** → add **Microsoft** (Entra ID) → **Require authentication**; unauthenticated requests redirect to sign-in.
- In Entra ID → Enterprise applications → this app → **Assignment required: Yes**, and assign the Magicians group (plus any managers).
- The hub itself refuses every request that does not carry the sign-in header (`X-MS-CLIENT-PRINCIPAL-NAME`) that App Service authentication adds, so it cannot be opened around the sign-in by mistake.
- Sign-in emails must match the team list, which the hub reads from Jira (`first.last@amla.io`); that is how each person gets their own view.
- On a VM behind another proxy: the proxy must do the sign-in, set that header, and strip it from incoming requests. `REQUIRE_SIGNIN=false` turns the check off and is only acceptable for a server reachable solely inside the company network.

### 4. Link and Teams tab
- Optional custom domain, e.g. `magician-hub.<company domain>`.
- Add the URL as a **Website** tab in the Magicians Teams channel.

### 5. Updates
- Deploy from the `magician-hub` repo (Deployment Center or a GitHub Actions workflow). Changing `config.json` (team list, branches) is a redeploy.

## What the team does
Open the link, sign in with the company account, and optionally click **Turn on browser alerts**. Nothing to install.
