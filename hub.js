// Magician Hub: builds, PRs, review status and "where's my fix" for the team, with popups.
// No npm install needed. Run: node hub.js   (test a popup: node hub.js --test-popup)
// Local mode uses your Git login. Hosted mode (GITHUB_TOKEN set) serves the whole team from one server; see DEPLOY.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const HOSTED = !!process.env.GITHUB_TOKEN;
const PORT = Number(process.env.PORT) || cfg.port;
const HOST = process.env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1');
// Hosted, the hub only answers requests that came through the company sign-in (Azure App Service
// authentication adds this header). REQUIRE_SIGNIN=false is for a server reachable only inside the network.
const SIGNIN_HEADER = 'x-ms-client-principal-name';
const REQUIRE_SIGNIN = HOSTED && process.env.REQUIRE_SIGNIN !== 'false';
const HUB_URL = `http://localhost:${PORT}`;
// The team: config.json's list to start with, then refreshed daily from Jira (see syncTeam). Empty = everyone.
let team, loginPrefixes;
function setTeam(list) {
  team = new Set(list.map(e => e.toLowerCase()));
  loginPrefixes = [...team].map(e => e.split('@')[0].replace(/\./g, '-'));   // GitHub logins follow first.last@ -> first-last-amla
}
setTeam(cfg.team || []);
const teamByLogin = login => [...team].find((e, i) => login.toLowerCase().startsWith(loginPrefixes[i]));
const inTeam = login => !team.size || !!teamByLogin(login);

// Team member behind a run: the commit email, the login in a GitHub no-reply email
// (123+first-last-amla@users.noreply.github.com), or whoever started the run. null = not team.
function runAuthor(r) {
  const email = ((r.head_commit && r.head_commit.author && r.head_commit.author.email) || '').toLowerCase();
  if (!team.size) return email || r.actor.login;
  if (team.has(email)) return email;
  return teamByLogin((/^\d+\+([^@]+)@users\.noreply\.github\.com$/.exec(email) || [])[1] || r.actor.login) || null;
}

const runs = new Map();   // run id -> run summary shown on the page
const reasons = new Map();   // failed run id -> why it failed, looked up once
let seeded = false;       // first poll fills the list without popups
let token = null;         // Git login (local) or GITHUB_TOKEN (hosted), kept in memory only
let email = null;         // local mode: you (Windows popups are yours only); hosted: null
let lastError = null;
let lastPoll = null;
let prs = [];                   // open PRs by the team
let requests = [];              // open PRs (any author) with a team member asked to review
const seenRequests = new Map(); // "repo#number" -> reviewer logins already announced

// Windows toast through PowerShell's built-in WinRT API. Text goes in env vars, never into the script.
const TOAST_PS = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:HUB_TITLE)) > $null
$n.Item(1).AppendChild($t.CreateTextNode($env:HUB_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))`;

// Tests swap these: record popups instead of showing them, and fake the Git login.
const hooks = { popup: (...a) => { if (cfg.windowsPopups !== false) popup(...a); }, gitLogin: () => gitLogin() };

// Events for every team member; each person's page turns their own into clickable browser notifications.
// Windows popups (local mode) are only for you.
const events = [];
function notify(person, title, body, url) {
  events.push({ at: new Date().toISOString(), person, title, body, url });
  if (events.length > 300) events.shift();
  if (person && person === email) hooks.popup(title, body);
}

function popup(title, body) {
  console.log(`[popup] ${title} | ${body}`);
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST_PS],
    { env: { ...process.env, HUB_TITLE: title, HUB_BODY: body }, windowsHide: true },
    err => err && console.error('Popup failed:', err.message));
}

// Run a local tool (git, acli); resolves its output, or null if it failed.
function runCmd(file, args, input) {
  return new Promise(resolve => {
    const p = execFile(file, args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
      (err, out) => resolve(err ? null : out));
    p.stdin.end(input || '');
  });
}
const git = async (args, input) => ((await runCmd('git', args, input)) || '').trim();

// Same login Git uses for clone/push (Git Credential Manager). Nothing is saved by the hub.
async function gitLogin() {
  const out = await git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
  const m = /^password=(.+)$/m.exec(out);
  return m ? m[1] : null;
}

async function gh(url) {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'magician-hub' }
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${url}`);
  return res.json();
}

// First failed job, failed step and first error annotation (file:line + message).
async function failureReason(repo, runId) {
  try {
    const { jobs } = await gh(`/repos/${cfg.owner}/${repo}/actions/runs/${runId}/jobs`);
    const job = jobs.find(j => j.conclusion === 'failure');
    if (!job) return '';
    const step = (job.steps || []).find(s => s.conclusion === 'failure');
    const notes = await gh(`/repos/${cfg.owner}/${repo}/check-runs/${job.id}/annotations`);
    const err = notes.find(a => a.annotation_level === 'failure' && !/exit code/i.test(a.message));   // skip "exit code 1" noise
    const where = err && err.path && err.path !== '.github' ? `${path.basename(err.path)}:${err.start_line} ` : '';
    return [step && `Step: ${step.name}`, err && `${where}${err.message.split('\n')[0]}`].filter(Boolean).join(' · ');
  } catch (e) {
    return '';
  }
}

const buildSince = () => new Date(Date.now() - (cfg.buildDays || 14) * 86400000).toISOString();

// Every page of a GitHub list (up to maxPages of 100). `pick` gets the array out of wrapped responses.
async function ghAll(url, maxPages, pick = x => x) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = pick(await gh(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function pollRepo(repo) {
  // The full window on start, then only the newest page each poll.
  const since = encodeURIComponent('>=' + buildSince().slice(0, 10));
  const list = await ghAll(`/repos/${cfg.owner}/${repo}/actions/runs?created=${since}`, seeded ? 1 : 20, x => x.workflow_runs);
  // Runs still in progress that have dropped off the newest page.
  const seen = new Set(list.map(r => r.id));
  for (const run of [...runs.values()]) {
    if (run.repo === repo && run.status !== 'completed' && !seen.has(run.id)) list.push(await gh(`/repos/${cfg.owner}/${repo}/actions/runs/${run.id}`));
  }
  for (const r of list) {
    if (!r.actor || r.actor.type !== 'User') continue;   // skip bot runs (Copilot, Dependabot)
    const author = runAuthor(r);
    if (!author) continue;
    const prev = runs.get(r.id);
    const run = {
      id: r.id, repo, branch: r.head_branch, workflow: r.name, status: r.status,
      conclusion: r.conclusion, url: r.html_url, updated: r.updated_at, author,
      reason: reasons.get(r.id) || '', raw: { head_commit: { author: { email: (r.head_commit && r.head_commit.author && r.head_commit.author.email) || '' } }, actor: { login: r.actor.login } }
    };
    if (run.conclusion === 'failure' && !reasons.has(r.id)) reasons.set(r.id, run.reason = await failureReason(repo, r.id));
    runs.set(r.id, run);
    if (!seeded) continue;   // the first check only loads data
    const label = `${shortRepo(repo)}${keysIn(r.head_branch || '').slice(0, 1).map(k => ' ' + k).join('')}`;   // "webstore Z10-41122"
    if (!prev && r.status !== 'completed') {
      notify(author, `${label}: build started`, `${r.head_branch} · ${r.name}`, r.html_url);
    } else if (prev && prev.status !== 'completed' && r.status === 'completed') {
      notify(author, `${label}: build ${{ success: 'passed', failure: 'failed' }[r.conclusion] || r.conclusion.replace('_', ' ')}`,
        `${r.head_branch} · ${run.reason || r.name}`, r.html_url);
    }
  }
}

const shortRepo = r => r.replace(/^znode(10)?-/, '').replace(/-migration$|10x-page-builder$|^multifront-/, '');   // znode10-api-migration -> api
const search = q => gh(`/search/issues?per_page=50&q=${encodeURIComponent(`${q} org:${cfg.owner}`)}`);

function prSummary(p, repo) {
  return { repo: repo || p.repository_url.split('/').pop(), number: p.number, title: p.title,
    author: p.user.login, url: p.html_url, created: p.created_at, draft: !!p.draft };
}

// Why an open PR is parked (not waiting for review), or '' if it is active.
const TICKET = /\b[A-Z][A-Z0-9]+[- ]\d+\b/i;
function parkedReason(p) {
  const days = cfg.staleDays || 30;
  if (p.draft) return 'Draft';
  if (/\b(poc|wip)\b|do not merge/i.test(p.title)) return 'POC / WIP';
  if (!TICKET.test(`${p.title} ${p.head}`)) return 'No ticket key';
  if (Date.now() - new Date(p.updated) > days * 86400000) return `No activity for ${days}+ days`;
  return '';
}

// Review status from each reviewer's latest decision (requested_reviewers empties once someone reviews).
// approved | changes | commented | waiting (reviewer asked, no review yet) | none (no reviewer at all)
const reviewCache = new Map();   // "repo#number" -> { updated, review }
const isBot = u => u.type === 'Bot' || /\[bot\]$|automation/i.test(u.login);
function reviewOf(reviews, pr) {
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || isBot(r.user) || r.user.login === pr.author) continue;
    if (r.state === 'COMMENTED') { if (!latest.has(r.user.login)) latest.set(r.user.login, 'COMMENTED'); }
    else latest.set(r.user.login, r.state);   // APPROVED / CHANGES_REQUESTED / DISMISSED replace earlier ones
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes';
  if (states.includes('APPROVED')) return 'approved';
  if (states.includes('COMMENTED')) return 'commented';
  return pr.reviewers.length ? 'waiting' : 'none';
}
// When the deciding review happened: the latest approval or change request (for "approved 7 days ago").
const STATE_OF = { approved: 'APPROVED', changes: 'CHANGES_REQUESTED' };
const reviewedAt = (reviews, review) => reviews.filter(r => r.state === STATE_OF[review] && r.submitted_at)
  .map(r => r.submitted_at).sort().pop() || null;
async function addReviewStatus(list) {
  const todo = list.filter(p => (reviewCache.get(`${p.repo}#${p.number}`) || {}).updated !== p.updated);
  for (let i = 0; i < todo.length; i += 10) {   // 10 at a time; only PRs that changed since the last poll
    await Promise.all(todo.slice(i, i + 10).map(async p => {
      const key = `${p.repo}#${p.number}`, before = (reviewCache.get(key) || {}).review;
      const reviews = await ghAll(`/repos/${cfg.owner}/${p.repo}/pulls/${p.number}/reviews`, 3), review = reviewOf(reviews, p);
      reviewCache.set(key, { updated: p.updated, review, reviewAt: reviewedAt(reviews, review) });
      // Tell the author when their PR is approved or gets changes requested.
      const author = teamByLogin(p.author);
      if (seeded && author && before && before !== review && (review === 'approved' || review === 'changes')) {
        notify(author, `${review === 'approved' ? 'Approved' : 'Changes requested'}: ${p.repo} #${p.number}`, p.title, p.url);
      }
    }));
  }
  list.forEach(p => { const c = reviewCache.get(`${p.repo}#${p.number}`); p.review = c.review; p.reviewAt = c.reviewAt; });
}

async function pollPrs() {
  const lists = await Promise.all(cfg.repos.map(async repo =>
    (await ghAll(`/repos/${cfg.owner}/${repo}/pulls?state=open`, 10)).map(p => {
      const pr = { ...prSummary(p, repo), base: p.base.ref, head: p.head.ref, updated: p.updated_at,
        reviewers: p.requested_reviewers.map(u => u.login) };
      pr.parked = parkedReason(pr);
      return pr;
    })));
  const open = lists.flat().sort((a, b) => b.created.localeCompare(a.created));   // newest first
  prs = open.filter(p => inTeam(p.author));
  await addReviewStatus(prs);
  // Review requests come from each PR's requested reviewers, so one server works for the whole team.
  requests = open.filter(p => p.reviewers.some(l => team.size && teamByLogin(l)));
  for (const p of open) {
    const key = `${p.repo}#${p.number}`, before = seenRequests.get(key);
    if (seeded) {
      p.reviewers.filter(l => !(before && before.has(l)) && teamByLogin(l))
        .forEach(l => notify(teamByLogin(l), `Review requested: ${p.repo} #${p.number}`, `${p.author} · ${p.title}`, p.url));
    }
    seenRequests.set(key, new Set(p.reviewers));
  }
}

// true if the branch has the commit, 'squashed' if a squashed down-merge carried it,
// false if missing, null if the branch does not exist in that repo.
async function branchHas(repo, branch, shas, since, mentions) {
  for (const sha of shas) {
    try {
      const c = await gh(`/repos/${cfg.owner}/${repo}/compare/${encodeURIComponent(branch)}...${sha}?per_page=1`);
      if (c.status === 'identical' || c.status === 'behind') return true;
    } catch (e) {
      if (/ 404 /.test(e.message)) return null;
      throw e;
    }
  }
  // Squashed down-merges (e.g. "downmerge-int-to-dev10") copy the change without the original commit,
  // but keep the ticket key in their message.
  const recent = await gh(`/repos/${cfg.owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}&per_page=100`);
  return recent.some(c => mentions.test(c.commit.message)) ? 'squashed' : false;
}

// Where's my fix: PRs and commits for a ticket, and which tracked branches contain them.
async function findFix(key) {
  const mentions = new RegExp(`\\b${key}\\b`, 'i');
  const prItems = (await search(`${key} is:pr`)).items
    .map(p => ({ p, repo: p.repository_url.split('/').pop() })).filter(x => cfg.repos.includes(x.repo));
  const pulls = (await Promise.all(prItems.map(async ({ p, repo }) => {
    const d = await gh(`/repos/${cfg.owner}/${repo}/pulls/${p.number}`);
    return { ...prSummary(p, repo), base: d.base.ref, head: d.head.ref,
      state: d.merged_at ? 'merged' : d.state, sha: d.merged_at ? d.merge_commit_sha : null, date: d.merged_at };
  }))).filter(p => mentions.test(`${p.title} ${p.head}`));
  // Commit search only covers each repo's default branch; merged PRs cover the rest.
  const commits = (await gh(`/search/commits?per_page=100&q=${encodeURIComponent(`${key} org:${cfg.owner}`)}`)).items
    .filter(c => cfg.repos.includes(c.repository.name) && mentions.test(c.commit.message))
    .map(c => ({ repo: c.repository.name, sha: c.sha, date: c.commit.committer.date }));
  const shas = [...pulls.filter(p => p.sha), ...commits];
  const repos = [...new Set(shas.map(s => s.repo))];
  const rows = await Promise.all(repos.map(async repo => {
    const found = shas.filter(s => s.repo === repo);
    const mine = [...new Set(found.map(s => s.sha))];
    const since = new Date(Math.min(...found.map(s => new Date(s.date)))).toISOString();
    const branches = {};
    await Promise.all(cfg.trackBranches.map(async b => { branches[b] = await branchHas(repo, b, mine, since, mentions); }));
    return { repo, branches };
  }));
  return { key, trackBranches: cfg.trackBranches, rows, pulls, jira: await jiraTicket(key) };
}

// Jira, read-only. On your PC through the Atlassian CLI (acli) and your own Jira login; on the team server
// through a read-only account (JIRA_EMAIL + JIRA_API_TOKEN). HUB_JIRA=off turns it off.
// A personal Jira API token pasted on the page (PC only) is kept in the Windows profile, never in the repo.
const DATA_DIR = process.env.MAGICIAN_HUB_DATA || path.join(process.env.APPDATA || require('os').homedir(), 'MagicianHub');
const TOKEN_FILE = path.join(DATA_DIR, 'jira.json');
function savedJiraLogin() { try { return HOSTED ? null : JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (e) { return null; } }
let jiraAuth = process.env.JIRA_API_TOKEN ? { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN } : savedJiraLogin();
const jiraBasic = () => 'Basic ' + Buffer.from(`${jiraAuth.email}:${jiraAuth.token}`).toString('base64');
let JIRA_MODE = process.env.HUB_JIRA === 'off' ? null : jiraAuth ? 'api' : HOSTED ? null : 'acli';
const ACLI = process.env.HUB_ACLI || 'acli';   // tests point this at a command that doesn't exist

// Team list from Jira, once a day: everyone assigned at least teamMinTickets tickets with Team = teamName in the
// last teamDays days. Saved in the data folder so a restart keeps it; config.json's list is the start and fallback.
const TEAM_FILE = path.join(DATA_DIR, 'team.json');
let teamInfo = { source: 'config', at: null }, teamSyncing = false;
try {
  const saved = JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8'));
  if (Array.isArray(saved.team) && saved.team.length) { setTeam(saved.team); teamInfo = { source: 'jira', at: saved.at }; }
} catch (e) { /* no saved list yet */ }
async function syncTeam() {
  if (!JIRA_MODE || jiraError || cfg.teamSync === false || !cfg.teamField || teamSyncing) return null;
  teamSyncing = true;
  try {
    const found = await jiraSearch(`${cfg.teamField} = "${cfg.teamName}" AND updated >= -${cfg.teamDays || 90}d AND assignee is not EMPTY`, 5000);
    const count = {};
    found.forEach(i => { if (i.assignee) count[i.assignee] = (count[i.assignee] || 0) + 1; });
    const list = Object.keys(count).filter(e => count[e] >= (cfg.teamMinTickets || 5)).sort();
    if (list.length < 3) return null;   // a bad answer from Jira must not empty the team
    setTeam(list);
    teamInfo = { source: 'jira', at: new Date().toISOString() };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TEAM_FILE, JSON.stringify({ at: teamInfo.at, team: list }));
    return list;
  } catch (e) {
    console.error('Team sync:', e.message);
    return null;
  } finally { teamSyncing = false; }
}
const teamSyncDue = () => !teamInfo.at || Date.now() - new Date(teamInfo.at) > 24 * 3600000;
let jiraError = JIRA_MODE ? null : HOSTED ? 'Jira is not connected on the team server.' : 'Jira is turned off.';
let jiraNeedsToken = false;     // PC: the saved token was rejected, so the page asks for a new one
let jiraKeys = {};              // ticket key -> ticket, for every ticket named in an open PR
const jiraMine = new Map();      // person -> { at, list } of their open tickets, fetched when they look (5 min cache)
let lastJira = 0;

function jiraIssue(i) {
  const f = i.fields || {};
  return { key: i.key, summary: f.summary || '', status: f.status ? f.status.name : '',
    cat: f.status && f.status.statusCategory ? f.status.statusCategory.key : '',   // new | indeterminate | done
    priority: f.priority ? f.priority.name : '', type: f.issuetype ? f.issuetype.name : '',
    assignee: f.assignee && f.assignee.emailAddress ? f.assignee.emailAddress.toLowerCase() : '' };
}
// Raw Jira API search (team server). `fields` can include timetracking and worklog.
async function jiraApi(jql, limit, fields) {
  const site = new URL(cfg.jiraUrl).origin, issues = [];
  const auth = jiraBasic();
  let next = '';
  do {
    const q = new URLSearchParams({ jql, maxResults: String(Math.min(100, limit - issues.length)), fields });
    if (next) q.set('nextPageToken', next);
    const res = await fetch(`${site}/rest/api/3/search/jql?${q}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Jira ${res.status}`);
    const d = await res.json();
    issues.push(...d.issues);
    next = d.nextPageToken || '';
  } while (next && issues.length < limit);
  return issues;
}
async function jiraSearch(jql, limit = 100) {
  if (JIRA_MODE === 'api') return (await jiraApi(jql, limit, 'summary,status,priority,issuetype,assignee')).map(jiraIssue);
  const out = await runCmd(ACLI, ['jira', 'workitem', 'search', '--jql', jql, '--fields', 'key,summary,status,priority,issuetype,assignee', '--limit', String(limit), '--json']);
  if (out === null) throw new Error('acli failed');
  return out.trim().startsWith('[') ? JSON.parse(out).map(jiraIssue) : [];
}
// Tickets by key. Jira rejects the whole query if one key doesn't exist, so failing batches are split.
async function jiraByKeys(keys) {
  if (!keys.length) return [];
  try {
    return await jiraSearch(`key in (${keys.join(',')})`, keys.length);
  } catch (e) {
    if (keys.length === 1) return [];
    const half = Math.ceil(keys.length / 2);
    return [...await jiraByKeys(keys.slice(0, half)), ...await jiraByKeys(keys.slice(half))];
  }
}
const keysIn = text => [...text.matchAll(ticketRe())].map(m => `${m[1]}-${m[2]}`.toUpperCase());
// Every few minutes: the Jira status of each ticket named in an open PR (about two searches).
async function pollJira() {
  if (!JIRA_MODE) return;
  lastJira = Date.now();
  try {
    await jiraSearch('assignee = currentUser()', 1);   // is Jira reachable with this login?
    const found = {}, keys = [...new Set(prs.flatMap(p => keysIn(`${p.title} ${p.head}`)))];
    for (let i = 0; i < keys.length; i += 100) (await jiraByKeys(keys.slice(i, i + 100))).forEach(t => { found[t.key] = t; });
    jiraKeys = found; jiraError = null;
  } catch (e) {
    // A PC's personal token stopped working (expired or revoked): fall back to acli and ask for a new token.
    if (JIRA_MODE === 'api' && !HOSTED && / 40[13]$/.test(e.message)) {
      JIRA_MODE = 'acli'; jiraNeedsToken = true; timeCache.clear(); jiraMine.clear();
      console.error('Jira: the saved API token was rejected; using the Atlassian CLI until a new token is pasted.');
      return pollJira();
    }
    jiraError = JIRA_MODE === 'acli' ? 'Jira isn\'t connected: install the Atlassian CLI (acli), run "acli jira auth login", then restart the hub.'
      : 'Jira isn\'t connected: the team server could not read Jira (JIRA_EMAIL / JIRA_API_TOKEN).';
    console.error('Jira:', e.message);
  }
}
// Time tracking and worklogs per ticket: one search on the team server; one `acli ... view` per ticket on a PC (6 at a time).
const adfText = n => !n ? '' : typeof n === 'string' ? n : [n.text || '', ...(n.content || []).map(adfText)].join(' ').replace(/\s+/g, ' ');
async function jiraTimeDetails(keys) {
  const out = {};
  const keep = (key, f) => {
    const tt = f.timetracking || {}, wl = f.worklog || {};
    out[key] = { estimate: tt.originalEstimateSeconds || 0, spent: tt.timeSpentSeconds || f.timespent || 0,
      partial: (wl.total || 0) > (wl.worklogs || []).length, logCount: wl.total || 0,   // Jira inlines only the oldest 20 logs
      remaining: tt.remainingEstimateSeconds === undefined ? null : tt.remainingEstimateSeconds,
      worklogs: ((f.worklog || {}).worklogs || []).map(w => ({ author: ((w.author && w.author.emailAddress) || '').toLowerCase(),
        started: w.started, seconds: w.timeSpentSeconds || 0, comment: adfText(w.comment).trim() })) };
  };
  if (JIRA_MODE === 'api') {
    for (let i = 0; i < keys.length; i += 100) (await jiraApi(`key in (${keys.slice(i, i + 100).join(',')})`, 100, 'timetracking,worklog,timespent')).forEach(x => keep(x.key, x.fields || {}));
    // More than 20 logs: read the last 14 days' logs in full.
    const site = new URL(cfg.jiraUrl).origin, auth = jiraBasic();
    for (const [key, d] of Object.entries(out).filter(([, d]) => d.partial)) {
      const res = await fetch(`${site}/rest/api/3/issue/${key}/worklog?startedAfter=${Date.now() - 14 * 86400000}`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (res.ok) keep(key, { timetracking: { originalEstimateSeconds: d.estimate, timeSpentSeconds: d.spent, remainingEstimateSeconds: d.remaining }, worklog: await res.json() });
    }
  } else {
    for (let i = 0; i < keys.length; i += 6) {
      await Promise.all(keys.slice(i, i + 6).map(async k => {
        const raw = await runCmd(ACLI, ['jira', 'workitem', 'view', k, '--fields', 'timetracking,worklog,timespent', '--json']);
        if (raw && raw.trim().startsWith('{')) keep(k, JSON.parse(raw).fields || {});
      }));
    }
  }
  return out;
}
// Time page: what a person logged in the last 14 days, and estimate vs logged for their open tickets (5 min cache).
const timeCache = new Map();
async function timeFor(person) {
  const hit = timeCache.get(person);
  if (hit && Date.now() - hit.at < 300000) return hit.data;
  const since = new Date(Date.now() - 14 * 86400000);
  const [logged, open] = await Promise.all([jiraSearch(`worklogAuthor = "${person}" AND worklogDate >= -14d ORDER BY updated DESC`, 60), jiraFor(person)]);
  const byKey = {}; [...logged, ...open].forEach(t => { byKey[t.key] = t; });
  const details = await jiraTimeDetails(Object.keys(byKey));
  const entries = Object.entries(details).flatMap(([key, d]) => d.worklogs
    .filter(w => w.author === person && new Date(w.started) >= since)
    .map(w => ({ key, summary: byKey[key].summary, started: w.started, seconds: w.seconds, comment: w.comment })))
    .sort((a, b) => new Date(b.started) - new Date(a.started));
  const tickets = open.map(t => ({ ...t, ...(details[t.key] ? { estimate: details[t.key].estimate, spent: details[t.key].spent, remaining: details[t.key].remaining } : {}) }));
  // Tickets with more than 20 logs where recent logs can't be read through acli (PC without a Jira API token)
  const partial = Object.keys(details).filter(k => details[k].partial).map(k => ({ key: k, summary: byKey[k].summary, logs: details[k].logCount }));
  const data = { person, since: since.toISOString(), entries, tickets, partial, weekHours: cfg.weekHours || 40 };
  timeCache.set(person, { at: Date.now(), data });
  return data;
}

// One person's open tickets (all of them, newest first), cached for 5 minutes.
async function jiraFor(person) {
  const hit = jiraMine.get(person);
  if (hit && Date.now() - hit.at < 300000) return hit.list;
  const list = await jiraSearch(`assignee = "${person}" AND resolution = Unresolved ORDER BY updated DESC`, 200);
  jiraMine.set(person, { at: Date.now(), list });
  return list;
}
// Connect a personal Jira API token from the page: check it with Jira, save it in the profile, switch to the API now.
// Log time in Jira as you (PC with your own API token only; the team server would log as its service account).
// Time like "2h 30m", "2.5", "2.5h" or "45m"; the date defaults to today and can't be in the future.
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^\d+(\.\d+)?h?$/.test(t)) return Math.round(parseFloat(t) * 3600);
  const m = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/.exec(t);
  return m && (m[1] || m[2]) ? Math.round(parseFloat(m[1] || 0) * 3600 + parseInt(m[2] || 0, 10) * 60) : 0;
}
async function logWork({ key, time, date, comment }) {
  if (HOSTED) return { error: 'Log time in Jira directly: the team server can\'t log time as you.' };
  if (JIRA_MODE !== 'api' || jiraNeedsToken) return { error: 'Connect your Jira API token on the Time page first.' };
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key || '')) return { error: 'Pick a ticket.' };
  const seconds = parseDuration(time);
  if (seconds < 60 || seconds > 24 * 3600) return { error: 'Enter the time like 2h 30m, 1.5 or 45m.' };
  const today = new Date().toLocaleDateString('en-CA'), day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today;
  if (day > today) return { error: 'The date can\'t be in the future.' };
  const off = -new Date(`${day}T09:00:00`).getTimezoneOffset(), pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const body = { timeSpentSeconds: seconds, started: `${day}T09:00:00.000${off < 0 ? '-' : '+'}${pad(off / 60)}${pad(off % 60)}` };
  if ((comment || '').trim()) body.comment = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment.trim().slice(0, 2000) }] }] };
  const res = await fetch(`${new URL(cfg.jiraUrl).origin}/rest/api/3/issue/${key}/worklog`, {
    method: 'POST', headers: { Authorization: jiraBasic(), Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    // Jira says why (a required field, a closed period, time tracking off ...): pass its words on.
    let why = '';
    try { const j = await res.json(); why = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join(' ').trim(); } catch (e) { /* no JSON body */ }
    console.error(`Log time on ${key} failed: Jira ${res.status} ${why}`);
    if (res.status === 404 || res.status === 403) return { error: `You can't log time on ${key} (not found or no permission).${why ? ' Jira: ' + why : ''}` };
    return { error: why ? `Jira did not accept it: ${why}` : `Jira answered ${res.status}. Try again.` };
  }
  timeCache.delete(jiraAuth.email);
  return { ok: true, key, seconds, day };
}

// One ticket's time for the Log time form (read only): estimate, logged, remaining, and whether its estimate can be set.
async function ticketTime(key) {
  if (HOSTED || JIRA_MODE !== 'api' || jiraNeedsToken) return { error: 'Connect your Jira API token on the Time page first.' };
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key || '')) return { error: 'Pick a ticket.' };
  const site = new URL(cfg.jiraUrl).origin, headers = { Authorization: jiraBasic(), Accept: 'application/json' };
  const [res, perm] = await Promise.all([fetch(`${site}/rest/api/3/issue/${key}?fields=timetracking,issuetype,status&expand=editmeta`, { headers }),
    fetch(`${site}/rest/api/3/mypermissions?issueKey=${key}&permissions=WORK_ON_ISSUES`, { headers })]);   // may you log time here?
  if (!res.ok) return { error: `Jira answered ${res.status} for ${key}.` };
  const j = await res.json(), f = j.fields || {}, t = f.timetracking || {};
  let canLog = true;
  try { canLog = perm.ok ? (await perm.json()).permissions.WORK_ON_ISSUES.havePermission !== false : true; } catch (e) { /* unknown: let Jira decide */ }
  return { key, type: f.issuetype ? f.issuetype.name : '', status: f.status ? f.status.name : '',
    estimate: t.originalEstimateSeconds == null ? null : t.originalEstimateSeconds, spent: t.timeSpentSeconds || 0,
    remaining: t.remainingEstimateSeconds == null ? null : t.remainingEstimateSeconds,
    canSetEstimate: !!(j.editmeta && j.editmeta.fields && j.editmeta.fields.timetracking), canLog };
}

// Set a ticket's Original Estimate (PC only, your own token), e.g. before logging time on it.
async function setEstimate({ key, time }) {
  if (HOSTED) return { error: 'Set the estimate in Jira directly.' };
  if (JIRA_MODE !== 'api' || jiraNeedsToken) return { error: 'Connect your Jira API token on the Time page first.' };
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key || '')) return { error: 'Pick a ticket.' };
  const seconds = parseDuration(time);
  if (seconds < 60 || seconds > 1000 * 3600) return { error: 'Enter the estimate like 4h or 1h 30m.' };
  const m = Math.round(seconds / 60), text = `${Math.floor(m / 60)}h ${m % 60}m`;
  const res = await fetch(`${new URL(cfg.jiraUrl).origin}/rest/api/3/issue/${key}`, {
    method: 'PUT', headers: { Authorization: jiraBasic(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { timetracking: { originalEstimate: text } } }) });
  if (!res.ok) {
    let why = '';
    try { const j = await res.json(); why = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join(' ').trim(); } catch (e) { /* no JSON body */ }
    console.error(`Set estimate on ${key} failed: Jira ${res.status} ${why}`);
    return { error: why ? `Jira did not accept the estimate: ${why}` : `Jira answered ${res.status}. Try again.` };
  }
  timeCache.delete(jiraAuth.email);
  return { ok: true, key, seconds };
}

async function connectJira(email, token) {
  if (HOSTED) return { error: 'The team server uses its own Jira account.' };
  if (!/^[^@\s]+@[^@\s]+$/.test(email || '') || !(token || '').trim()) return { error: 'Enter your Jira email and the token.' };
  const candidate = { email: email.trim().toLowerCase(), token: token.trim() };
  const res = await fetch(`${new URL(cfg.jiraUrl).origin}/rest/api/3/myself`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${candidate.email}:${candidate.token}`).toString('base64'), Accept: 'application/json' } });
  if (!res.ok) return { error: res.status === 401 || res.status === 403 ? 'Jira did not accept that email and token. Check both and try again.' : `Jira answered ${res.status}. Try again.` };
  const me = await res.json();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(candidate), { mode: 0o600 });
  jiraAuth = candidate; JIRA_MODE = 'api'; jiraError = null; jiraNeedsToken = false;
  timeCache.clear(); jiraMine.clear(); lastJira = 0;
  await pollJira();
  return { ok: true, name: me.displayName || candidate.email };   // never send the token back
}
async function jiraTicket(key) {
  if (jiraKeys[key]) return jiraKeys[key];
  if (!JIRA_MODE || jiraError) return null;
  try { return (await jiraByKeys([key]))[0] || null; } catch (e) { return null; }
}

// A person's GitHub login: as seen on PRs and review requests, else the first-last-amla convention.
function loginOf(person) {
  const prefix = person.split('@')[0].replace(/\./g, '-');
  const seen = [...prs.map(p => p.author), ...requests.flatMap(p => p.reviewers)].find(l => l.toLowerCase().startsWith(prefix));
  return seen || `${prefix}-amla`;
}

// Standup: one person's PR activity since the last working day (Friday on a Monday).
function lastWorkday(now = new Date()) {
  const d = new Date(now); d.setDate(d.getDate() - (d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1));
  return d.toLocaleDateString('en-CA');   // YYYY-MM-DD in local time
}
async function standup(person) {
  const login = loginOf(person), since = lastWorkday();
  const pr = p => ({ ...prSummary(p), state: p.pull_request && p.pull_request.merged_at ? 'merged' : p.state });
  const [authored, reviewed] = await Promise.all([
    search(`is:pr author:${login} updated:>=${since}`),
    search(`is:pr reviewed-by:${login} -author:${login} updated:>=${since}`)]);
  const built = [...runs.values()].filter(r => r.author === person && r.updated.slice(0, 10) >= since);
  const [moved, sprints, activity] = JIRA_MODE && !jiraError ? await Promise.all([
    jiraSearch(`assignee = "${person}" AND statusCategoryChangedDate >= "${since}" ORDER BY updated DESC`, 20).catch(() => []),
    sprintsFor(person).catch(() => null), jiraActivity(person, since).catch(() => null)]) : [[], null, null];

  return { person, since, authored: authored.items.map(pr), reviewed: reviewed.items.map(pr),
    builds: { passed: built.filter(r => r.conclusion === 'success').length, failed: built.filter(r => r.conclusion === 'failure').length,
      failedList: built.filter(r => r.conclusion === 'failure').slice(0, 5).map(r => ({ repo: r.repo, branch: r.branch, url: r.url, reason: r.reason })) },
    moved, activity, sprints };
}

// What you did in Jira since a date, one entry per ticket: tickets you moved (from -> to), comments you wrote, who you assigned
// tickets to, attachments you added, tickets you created. Read from each ticket's history (Jira API only; worklogs are left out).
async function jiraActivity(person, since) {
  if (JIRA_MODE !== 'api') return null;
  const site = new URL(cfg.jiraUrl).origin, headers = { Authorization: jiraBasic(), Accept: 'application/json' };
  const users = await (await fetch(`${site}/rest/api/3/user/search?query=${encodeURIComponent(person)}`, { headers })).json();
  const me = (Array.isArray(users) ? users : []).find(u => (u.emailAddress || '').toLowerCase() === person);
  if (!me) return null;
  const q = new URLSearchParams({ jql: `issuekey in updatedBy("${me.accountId}", "${since}") ORDER BY updated DESC`, maxResults: '50',
    fields: 'summary,status,comment,created,reporter', expand: 'changelog' });
  const res = await fetch(`${site}/rest/api/3/search/jql?${q}`, { headers });
  if (!res.ok) throw new Error(`Jira ${res.status}`);
  const from = new Date(since + 'T00:00'), mine = a => !!a && a.accountId === me.accountId, after = t => new Date(t) >= from, out = [];
  for (const i of (await res.json()).issues || []) {
    const f = i.fields || {}, a = { key: i.key, summary: f.summary || '', status: f.status ? f.status.name : '', moves: [], comments: 0, assigned: null, attachments: 0,
      created: mine(f.reporter) && after(f.created) };
    for (const h of (i.changelog && i.changelog.histories) || []) {
      if (!mine(h.author) || !after(h.created)) continue;
      for (const it of h.items) {
        if (it.field === 'status') a.moves.push({ from: it.fromString, to: it.toString, at: h.created });
        else if (it.field === 'assignee' && it.toString) a.assigned = it.toString;
        else if (it.field === 'Attachment' && it.toString) a.attachments++;
      }
    }
    a.moves.sort((x, y) => x.at.localeCompare(y.at));
    a.comments = ((f.comment || {}).comments || []).filter(c => mine(c.author) && after(c.created)).length;
    if (a.created || a.moves.length || a.comments || a.assigned || a.attachments) out.push(a);
  }
  return out;
}

// Your tickets in the active sprints (team sprints first, the one ending soonest first). Needs the Jira API: the CLI can't read the Sprint field.
async function sprintsFor(person) {
  if (JIRA_MODE !== 'api') return null;
  const field = cfg.sprintField || 'customfield_10010';
  const issues = await jiraApi(`assignee = "${person}" AND sprint in openSprints() ORDER BY status`, 200, `summary,status,${field}`);
  const byId = {};
  for (const i of issues) {
    const t = jiraIssue(i);
    for (const s of (i.fields[field] || []).filter(x => x.state === 'active')) {
      const sp = byId[s.id] = byId[s.id] || { name: s.name, start: s.startDate, end: s.endDate, goal: s.goal || '', done: 0, doing: 0, todo: 0, tickets: [] };
      sp[t.cat === 'done' ? 'done' : t.cat === 'indeterminate' ? 'doing' : 'todo']++;
      sp.tickets.push({ key: t.key, summary: t.summary, status: t.status, cat: t.cat });
    }
  }
  const team = new RegExp(cfg.teamName || '^$', 'i');
  return Object.values(byId).sort((a, b) => (team.test(b.name) - team.test(a.name)) || String(a.end).localeCompare(String(b.end))).slice(0, 3);
}

// Release notes: every ticket in the commits between two refs, across all repos.
// Titles come from the commit lines that mention the ticket, so squashed down-merges count too.
const ticketRe = () => new RegExp(`\\b(${(cfg.ticketPrefixes || ['Z10']).join('|')})[-_ ](\\d+)\\b`, 'gi');
async function releaseNotes(from, to) {
  const tickets = new Map(), missing = [], truncated = [];
  await Promise.all(cfg.repos.map(async repo => {
    let cmp;
    try {
      cmp = await gh(`/repos/${cfg.owner}/${repo}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`);
    } catch (e) {
      if (/ 404 /.test(e.message)) return missing.push(repo);
      throw e;
    }
    if (cmp.total_commits > cmp.commits.length) truncated.push(repo);   // compare returns at most 250 commits
    for (const c of cmp.commits) {
      for (const line of c.commit.message.split('\n')) {
        for (const m of line.matchAll(ticketRe())) {
          const key = `${m[1]}-${m[2]}`.toUpperCase();
          const title = line.slice(m.index + m[0].length).replace(/^[\s:\-–—]+/, '').replace(/\s*\(#\d+\)/g, '').trim();
          // Best title: from a line that starts with this ticket ("Z10-1: ...", "* Z10-1 ..."), then the longest.
          const rank = (/^\W{0,3}$/.test(line.slice(0, m.index)) ? 2 : 1) * 1000 + title.length;
          const t = tickets.get(key) || { key, title: '', rank: 0, repos: new Set() };
          t.repos.add(repo);
          if (!/^merge\b/i.test(line) && title && rank > t.rank) Object.assign(t, { title, rank });
          tickets.set(key, t);
        }
      }
    }
  }));
  if (missing.length === cfg.repos.length) return { error: `Couldn't find ${from} or ${to} in any repo.` };
  const list = [...tickets.values()].map(t => ({ key: t.key, title: t.title, repos: [...t.repos] })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  // Jira summaries and status, when Jira is connected (one search per 100 tickets).
  if (JIRA_MODE && !jiraError) {
    const known = {}, missing2 = list.map(t => t.key).filter(k => !jiraKeys[k]);
    for (let i = 0; i < missing2.length; i += 100) (await jiraByKeys(missing2.slice(i, i + 100))).forEach(t => { known[t.key] = t; });
    list.forEach(t => { t.jira = jiraKeys[t.key] || known[t.key] || null; });
  }
  return { from, to, tickets: list, missing, truncated };
}

// Impact check: what a PR's changes can break, read from each file's name and diff, with a risk level and reason.
// Each finding also names something to look for in the other repos (code search, 8 at a time).
function findingsFor(f, repo) {
  const out = [], base = path.basename(f.filename).replace(/\.\w+$/, ''), patch = f.patch || '';
  const lines = sign => patch.split('\n').filter(l => l[0] === sign && !l.startsWith(sign.repeat(3))).map(l => l.slice(1));
  const added = lines('+'), removed = lines('-'), addedText = new Set(added.map(l => l.trim()));
  const names = (list, re) => new Set(list.flatMap(l => [...l.matchAll(re)].map(m => m[1])));
  const gone = re => { const now = names(added, re); return [...names(removed, re)].filter(x => !now.has(x)); };   // removed, not re-added
  const add = (kind, name, risk, why, search = name) => out.push({ kind, name, risk, why, search, repo, file: f.filename });

  if ((f.status === 'removed' || f.status === 'renamed') && /\.(cs|ts|tsx|js|jsx|sql|cshtml)$/i.test(f.filename)) {
    const old = path.basename(f.previous_filename || f.filename).replace(/\.\w+$/, '');
    add('Deleted or renamed file', old, 'high', f.status === 'removed' ? 'File deleted: anything that uses it breaks.' : `Renamed to ${path.basename(f.filename)}: anything using the old name breaks.`);
  }
  if (/\.sql$/i.test(f.filename)) {
    const proc = /(?:CREATE|ALTER)(?:\s+OR\s+ALTER)?\s+PROC(?:EDURE)?\s+(?:\[?\w+\]?\.)?\[?(\w+)\]?/i.exec(patch);
    if (proc || /proc/i.test(f.filename)) {
      const param = /^\s*,?\s*(@\w+)\s+[\w\[\]]+(?:\s*\([^)]*\))?\s*(=)?/, isParam = l => param.test(l) && !/\b(DECLARE|SET|SELECT|EXEC|WHERE|AND|OR|INSERT|UPDATE)\b/i.test(l);
      const before = new Set(removed.filter(isParam).map(l => param.exec(l)[1]));
      const required = added.filter(l => isParam(l) && !param.exec(l)[2]).map(l => param.exec(l)[1]).filter(p => !before.has(p));
      const dropped = [...before].filter(p => !added.some(l => isParam(l) && param.exec(l)[1] === p));
      const name = proc ? proc[1] : base;
      if (required.length) add('Database procedure', name, 'high', `New parameter without a default (${required.join(', ')}): every caller must now pass it.`);
      else if (dropped.length) add('Database procedure', name, 'high', `Parameter removed (${dropped.join(', ')}): callers that still pass it break.`);
      else add('Database procedure', name, 'medium', 'Procedure changed: callers should still match its parameters and results.');
    }
    names(added, /DROP\s+COLUMN\s+\[?(\w+)\]?/gi).forEach(c => add('Database column', c, 'high', 'Column dropped: code that reads or writes it breaks.'));
    names(added, /sp_rename\s+N?'(?:[\w\[\]]+\.)*\[?(\w+)\]?'/gi).forEach(c => add('Database column', c, 'high', 'Renamed with sp_rename: code using the old name breaks.'));
    names(added, /ALTER\s+COLUMN\s+\[?(\w+)\]?/gi).forEach(c => add('Database column', c, 'medium', 'Column type or size changed: check code that reads or writes it.'));
    names(added, /DROP\s+(?:TABLE|VIEW|FUNCTION)\s+(?:IF\s+EXISTS\s+)?(?:\[?\w+\]?\.)?\[?(\w+)\]?/gi).forEach(t => add('Database object', t, 'high', 'Table, view or function dropped: everything using it breaks.'));
  }
  if (/\.cs$/i.test(f.filename)) {
    if (/(Model|Dto|DTO|Entity|Request|Response)$/.test(base) || /\/(Models|DTOs?|Entities|ViewModels)\//i.test(f.filename)) {
      const props = gone(/public\s+[\w<>\[\],?.\s]+?\s+(\w+)\s*\{\s*get/g);
      add('C# data model', base, props.length ? 'high' : 'medium',
        props.length ? `Property removed or renamed (${props.join(', ')}): code using it breaks.` : 'Model changed: check the repos that send or read it.');
    }
    if (/Controller$/.test(base)) {
      gone(/\[(?:Route|Http(?:Get|Post|Put|Delete|Patch))\(\s*"([^"]+)"/g).forEach(r =>
        add('API route', r, 'high', 'Route removed or changed: callers of this URL break.', r.replace(/\{[^}]*\}/g, '').replace(/^\/+|\/+$/g, '')));
    }
    if (/^I[A-Z]\w*$/.test(base)) {
      const sig = /^\s*(?:public\s+)?(?:Task<[^>]*>|[\w<>\[\],?.]+)\s+(\w+)\s*\(/, now = new Set(added.map(l => (sig.exec(l) || [])[1]).filter(Boolean));
      removed.filter(l => sig.test(l) && !addedText.has(l.trim())).forEach(l => {
        const n = sig.exec(l)[1];
        add('Interface method', n, 'high', now.has(n) ? 'Signature changed: every implementation and caller must change.' : 'Method removed: every implementation and caller breaks.');
      });
    }
  }
  if (/\.(ts|tsx|js|jsx)$/i.test(f.filename)) {
    gone(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g)
      .forEach(n => add('Exported code', n, 'medium', 'Export removed or renamed: files importing it break.'));
  }
  if (/(appsettings[\w.]*\.json|\.config|\.env[\w.]*)$/i.test(f.filename)) {
    [...gone(/"(\w[\w.:-]*)"\s*:/g), ...gone(/<add\s+key="([^"]+)"/g)]
      .forEach(k => add('Config setting', k, 'medium', 'Setting removed or renamed: code that reads it gets nothing.'));
  }
  if (/\.resx$/i.test(f.filename)) gone(/<data\s+name="([^"]+)"/g).forEach(k => add('Text resource', k, 'low', 'Text key removed: screens that show it break.'));
  return out;
}
const usageCache = new Map();   // search -> { at, items }
async function impact(input, from = 0) {
  // Only open PRs: the question is whether it is safe to merge.
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(input);
  let targets;
  if (m) {
    const pr = await gh(`/repos/${cfg.owner}/${m[1]}/pulls/${m[2]}`);
    if (pr.state !== 'open') return { error: pr.merged_at ? 'This PR is already merged.' : 'This PR is closed.' };
    targets = [{ repo: m[1], number: +m[2] }];
  } else {
    const key = parseKey(input);
    if (!key) return { error: 'Enter a PR link or a ticket key.' };
    targets = (await search(`${key} is:pr is:open`)).items.map(p => ({ repo: p.repository_url.split('/').pop(), number: p.number }))
      .filter(t => cfg.repos.includes(t.repo));
  }
  const found = new Map(), stats = { files: 0, additions: 0, deletions: 0, tests: 0, repos: new Set() };
  const RANK = { high: 0, medium: 1, low: 2 };
  for (const t of targets) {
    for (const f of await ghAll(`/repos/${cfg.owner}/${t.repo}/pulls/${t.number}/files`, 3)) {
      Object.assign(stats, { files: stats.files + 1, additions: stats.additions + (f.additions || 0), deletions: stats.deletions + (f.deletions || 0) });
      stats.repos.add(t.repo);
      if (/(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.\w+$|Tests?\.cs$/i.test(f.filename)) stats.tests++;
      for (const x of findingsFor(f, t.repo)) {   // one entry per kind + name, keeping the riskiest
        const k = `${x.kind}|${x.name}`, prev = found.get(k);
        if (!prev || RANK[x.risk] < RANK[prev.risk]) found.set(k, x);
      }
    }
  }
  const findings = [...found.values()].sort((a, b) => RANK[a.risk] - RANK[b.risk]);
  // Code search allows about 10 requests a minute, so check 8 at a time ("Check next 8"), only in the Znode repos we care about.
  let limited = false;   // true when GitHub's search limit stopped some checks
  const scope = (cfg.impactRepos || cfg.repos).map(r => `repo:${cfg.owner}/${r}`).join(' ');
  for (const n of findings.slice(from, from + 8)) {
    try {
      const hit = usageCache.get(n.search);
      if (!hit || Date.now() - hit.at > 3600000) {   // the whole team shares GitHub's search limit, so reuse results for an hour
        const r = await gh(`/search/code?per_page=50&q=${encodeURIComponent(`"${n.search}" ${scope}`)}`);
        usageCache.set(n.search, { at: Date.now(), items: r.items.map(i => ({ repo: i.repository.name, path: i.path, url: i.html_url })) });
      }
      // Leave out the changed file itself and other repos' files that only share the name (their own copy, not a use).
      n.usages = usageCache.get(n.search).items.filter(i => i.repo === n.repo ? i.path !== n.file
        : path.basename(i.path).replace(/\.\w+$/, '') !== n.name);
    } catch (e) {
      if (!/ 403 | 429 /.test(e.message)) throw e;
      n.usages = null; limited = true;   // rate limited: shown as "not checked"
    }
  }
  return { prs: targets.map(t => `${t.repo}#${t.number}`), findings, from, checkedTo: Math.min(findings.length, from + 8),
    total: findings.length, limited, stats: { ...stats, repos: [...stats.repos] } };
}

// Friday reminder: at cfg.timeReminder ("Fri 16:00", server time), anyone under weekHours this week gets a popup / alert.
// On a PC that is you; on the team server, every team member.
const hm = sec => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
const reminded = new Set();   // days already reminded
async function timeReminder(now = new Date()) {
  const [dayName, slot] = (cfg.timeReminder || 'Fri 16:00').split(' ');
  if (now.toLocaleDateString('en-US', { weekday: 'short' }) !== dayName || now.toTimeString().slice(0, 5) !== slot) return [];
  if (reminded.has(now.toDateString()) || !JIRA_MODE || jiraError) return [];
  reminded.add(now.toDateString());
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const target = (cfg.weekHours || 40) * 3600, sent = [];
  for (const person of HOSTED ? [...team] : email ? [email] : []) {
    try {
      const week = (await timeFor(person)).entries.filter(e => new Date(e.started) >= monday).reduce((n, e) => n + e.seconds, 0);
      if (week >= target) continue;
      notify(person, `Time: ${hm(week)} logged this week`, `${hm(target - week)} still to log in Jira before the weekend`, '/#time');
      sent.push(person);
    } catch (e) { console.error('Time reminder:', e.message); }
  }
  return sent;
}

// Personal nudges on a schedule (server time). Each fires once per day; each person only hears about their own work.
const daysAgo = (at, now) => { const d = Math.floor((now - new Date(at)) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
// Up to 3 items: one popup each. More: one summary that opens the page.
function nudgePerson(person, items, summary, url) {
  if (items.length <= 3) items.forEach(i => notify(person, i.title, i.body, i.url));
  else notify(person, summary(items.length), items.slice(0, 2).map(i => i.title).join(' · ') + ` · and ${items.length - 2} more`, url);
}

// 12:00: your approved PRs to merge, change requests a day or more old, and PRs whose Jira ticket is already Done.
function prNudges(now) {
  const byPerson = {};
  for (const p of prs.filter(x => !x.parked)) {
    const person = teamByLogin(p.author);
    if (!person) continue;
    const name = `${shortRepo(p.repo)} #${p.number}`, add = (title) => (byPerson[person] = byPerson[person] || []).push({ title, body: p.title, url: p.url });
    if (p.review === 'approved') add(`Your PR ${name} was approved${p.reviewAt ? ' ' + daysAgo(p.reviewAt, now) : ''}. Merge it`);
    else if (p.review === 'changes' && (!p.reviewAt || now - new Date(p.reviewAt) >= 86400000)) add(`Changes requested on ${name}${p.reviewAt ? ' ' + daysAgo(p.reviewAt, now) : ''}. Address them`);
    const done = keysIn(`${p.title} ${p.head}`).map(k => jiraKeys[k]).find(t => t && t.cat === 'done');
    if (done) add(`${done.key} is Done in Jira but its PR ${name} is still open`);
  }
  Object.entries(byPerson).forEach(([person, items]) => nudgePerson(person, items, n => `${n} of your PRs need you`, '/#prs'));
  return Object.keys(byPerson);
}

// 18:00 on weekdays: anyone under dayHours logged today.
async function dayCheck(now) {
  if (now.getDay() === 0 || now.getDay() === 6 || !JIRA_MODE || jiraError) return [];
  const target = (cfg.dayHours || 8) * 3600, today = now.toLocaleDateString('en-CA'), sent = [];
  for (const person of HOSTED ? [...team] : email ? [email] : []) {
    try {
      timeCache.delete(person);   // fresh numbers, not a 5-minute-old copy
      const sec = (await timeFor(person)).entries.filter(e => new Date(e.started).toLocaleDateString('en-CA') === today).reduce((n, e) => n + e.seconds, 0);
      if (sec >= target) continue;
      notify(person, `Today: ${hm(sec)} logged`, `${hm(target - sec)} to go. Log it in Jira or on the Time page`, '/#time');
      sent.push(person);
    } catch (e) { console.error('Day check:', e.message); }
  }
  return sent;
}

// Monday 10:00: your PRs with no activity for 30+ days (drafts and POCs included), to close or update.
function staleNudges(now) {
  const byPerson = {};
  prs.filter(p => now - new Date(p.updated) > (cfg.staleDays || 30) * 86400000).forEach(p => {
    const person = teamByLogin(p.author);
    if (person) (byPerson[person] = byPerson[person] || []).push(p);
  });
  Object.entries(byPerson).forEach(([person, list]) => notify(person,
    `You have ${list.length} PR${list.length > 1 ? 's' : ''} with no activity for ${cfg.staleDays || 30}+ days`,
    'Close or update them: ' + list.slice(0, 3).map(p => `${shortRepo(p.repo)} #${p.number}`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : ''),
    list.length === 1 ? list[0].url : '/#prs'));
  return Object.keys(byPerson);
}

const fired = new Set();   // "job + date" already run
const dueNow = (spec, now) => {   // "12:00" (every day) or "Mon 10:00"
  const [a, b] = spec.split(' '), day = b ? a : null, slot = b || a;
  return (!day || now.toLocaleDateString('en-US', { weekday: 'short' }) === day) && now.toTimeString().slice(0, 5) === slot;
};
async function runJobs(now = new Date()) {
  const jobs = { prNudges: [cfg.prNudgeTime || '12:00', prNudges], dayCheck: [cfg.dayCheckTime || '18:00', dayCheck],
    staleNudges: [cfg.staleNudgeTime || 'Mon 10:00', staleNudges] }, ran = {};
  for (const [name, [spec, job]] of Object.entries(jobs)) {
    const key = `${name} ${now.toDateString()}`;
    if (!seeded || !dueNow(spec, now) || fired.has(key)) continue;
    fired.add(key);
    try { ran[name] = await job(now); } catch (e) { console.error(`${name}:`, e.message); }
  }
  return ran;
}

// Optional Teams nudge: with TEAMS_WEBHOOK_URL set (a Teams "Workflows" webhook), post a short digest of
// PRs that need someone at each time in cfg.nudgeTimes. Set it on the team server only, or it posts twice.
function nudgeText(now = Date.now()) {
  const active = prs.filter(p => !p.parked), line = p => `${p.repo.replace(/^znode(10)?-/, '')} #${p.number} · ${p.author} · ${p.title}`;
  const groups = [
    ['Ready to merge', active.filter(p => p.review === 'approved')],
    ['No reviewer', active.filter(p => p.review === 'none')],
    ['Waiting for review over 3 days', active.filter(p => p.review === 'waiting' && now - new Date(p.created) > 3 * 86400000)]
  ].filter(([, list]) => list.length);
  if (!groups.length) return null;
  return groups.map(([label, list]) => `**${label} (${list.length})**\n` + list.slice(0, 5).map(p => `- [${line(p)}](${p.url})`).join('\n')).join('\n\n');
}
const nudged = new Set();   // "YYYY-MM-DD HH:MM" slots already posted
async function nudge(now = new Date()) {
  const hook = process.env.TEAMS_WEBHOOK_URL, slot = now.toTimeString().slice(0, 5), day = now.toDateString();   // server's local time (TZ)
  if (!hook || !seeded || !(cfg.nudgeTimes || []).includes(slot) || nudged.has(`${day} ${slot}`)) return false;
  nudged.add(`${day} ${slot}`);
  const text = nudgeText(now.getTime());
  if (!text) return false;
  const card = { type: 'AdaptiveCard', version: '1.4', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [{ type: 'TextBlock', text: 'Magician Hub · PRs that need someone', weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text, wrap: true }] };
  const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }) });
  if (!res.ok) console.error(`Teams nudge failed: ${res.status}`);
  return res.ok;
}

let polling = false;   // a slow poll must not overlap the next one
async function poll() {
  if (polling) return;
  polling = true;
  try {
    await Promise.all(cfg.repos.map(pollRepo));
    await pollPrs();
    if (JIRA_MODE && Date.now() - lastJira > (cfg.jiraPollSeconds || 300) * 1000) await pollJira();   // own errors; never stops GitHub
    // Keep the page list short and recent.
    // Builds loaded before the team list arrived (first run): keep only the team's, before the 500 limit below.
    if (team.size) for (const r of runs.values()) if (!team.has(r.author) && !(r.author = runAuthor(r.raw))) runs.delete(r.id);
    const cutoff = buildSince();
    [...runs.values()].sort((a, b) => b.updated.localeCompare(a.updated))
      .filter((r, i) => (team.size && i >= 500) || r.updated < cutoff).forEach(r => runs.delete(r.id));   // no limit until the team is known
    seeded = true;
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error(e.message);
    if (/ 401 /.test(e.message)) {   // GitHub rejected the login
      if (HOSTED) lastError = 'GitHub rejected the team server\'s token (expired?). DevOps needs to renew GITHUB_TOKEN.';
      else {
        // Git Credential Manager usually has a refreshed login already: read it again and carry on next poll.
        const fresh = await hooks.gitLogin();
        if (fresh && fresh !== token) { token = fresh; lastError = null; }
        else lastError = 'Your GitHub login expired. Run "git fetch" in any MRRSoft repo to sign in again; the hub picks it up within a minute.';
      }
    }
  }
  polling = false;
  lastPoll = new Date().toISOString();
}

// Finds a ticket key in a key, Jira link or branch name ("z10 37238", ".../browse/Z10-37238"); a bare number means Z10.
function parseKey(input) {
  const m = /([A-Z][A-Z0-9]+)[-_ ](\d+)/i.exec(input);
  if (m) return `${m[1]}-${m[2]}`.toUpperCase();
  return /^\d+$/.test(input) ? `Z10-${input}` : null;
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, HUB_URL);
  if (url.pathname === '/health') return res.writeHead(200).end('ok');   // for the host's health check; no data
  const signedIn = String(req.headers[SIGNIN_HEADER] || '').toLowerCase();
  if (REQUIRE_SIGNIN && !signedIn) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Sign-in required: open Magician Hub through the company sign-in.');
  }
  // Actions that change something: connect a Jira token, log time. Only from this hub's own page on this PC:
  // POST, our own header (other websites can't send it without a CORS check we never answer), addressed to localhost.
  const actions = { '/api/jira-token': i => connectJira(i.email, i.token), '/api/worklog': i => logWork(i), '/api/estimate': i => setEstimate(i) };
  if (actions[url.pathname]) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
    if (HOSTED || req.method !== 'POST' || req.headers['x-magician-hub'] !== '1' || !local) return sendJson(res, 403, { error: 'Not allowed.' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return sendJson(res, 413, { error: 'Too long.' }); }
    let input = {};
    try { input = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'Something was missing. Try again.' }); }
    try {
      const result = await actions[url.pathname](input);
      return sendJson(res, result.error ? 400 : 200, result);
    } catch (e) {
      return sendJson(res, 502, { error: 'Could not reach Jira. Try again.' });
    }
  }
  if (url.pathname === '/api/state') {
    const list = [...runs.values()].sort((a, b) => b.updated.localeCompare(a.updated));
    // viewer: who is looking (from the sign-in when hosted, your Git email when local)
    const viewer = team.has(signedIn) ? signedIn : email;
    return sendJson(res, 200, { hosted: HOSTED, viewer, signedIn: !!signedIn, team: [...team].sort(), repos: cfg.repos, owner: cfg.owner,
      jira: cfg.jiraUrl, links: cfg.links, ticketPrefixes: cfg.ticketPrefixes, jiraOn: !!JIRA_MODE && !jiraError && lastJira > 0, jiraError, jiraNeedsToken, jiraKeys,
      teamInfo, canLogTime: !HOSTED && JIRA_MODE === 'api' && !jiraNeedsToken ? jiraAuth.email : null,   // whose time a "Log" writes
      lastPoll, lastError, runs: list, prs, requests, events });
  }
  const q = name => (url.searchParams.get(name) || '').trim();
  const tools = {   // on-demand lookups; each returns { error } on bad input
    '/api/fix': () => { const key = parseKey(q('key')); return key ? findFix(key) : { error: 'Enter a ticket key or Jira link, like Z10-41590.' }; },
    '/api/standup': () => team.has(q('person').toLowerCase()) ? standup(q('person').toLowerCase()) : { error: 'Pick your name at the top right first.' },
    '/api/ticket-time': () => ticketTime(q('key').toUpperCase()),
    '/api/release': () => q('from') && q('to') ? releaseNotes(q('from'), q('to')) : { error: 'Enter both refs, like v10.14.0.6 and v10.14.0.0-hotfixes.' },
    '/api/impact': () => q('pr') ? impact(q('pr'), Math.max(0, parseInt(q('from'), 10) || 0)) : { error: 'Enter a PR link or a ticket key.' },
    '/api/jira-mine': async () => {
      const person = q('person').toLowerCase();
      if (!team.has(person)) return { error: 'Pick your name at the top right first.' };
      if (!JIRA_MODE || jiraError) return { error: jiraError || 'Jira is not connected.' };
      return { person, tickets: await jiraFor(person) };
    },
    '/api/time': async () => {
      const person = q('person').toLowerCase();
      if (!team.has(person)) return { error: 'Pick your name at the top right first.' };
      if (!JIRA_MODE || jiraError) return { error: jiraError || 'Jira is not connected.' };
      if (q('refresh')) timeCache.delete(person);
      return timeFor(person);
    }
  };
  if (tools[url.pathname]) {
    if (!token) return sendJson(res, 503, { error: lastError || 'The hub is still starting. Try again in a few seconds.' });
    try {
      const result = await tools[url.pathname]();
      return sendJson(res, result.error ? 400 : 200, result);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });   // always the latest page
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(404).end();
});

// Used by test/popups.test.js; starting the hub (node hub.js) is below.
module.exports = { poll, pollJira, syncTeam, timeReminder, runJobs, parseDuration, hooks, popup, server, nudge, nudgeText, lastWorkday,
  setSession: s => { token = s.token; email = s.email; },
  state: () => ({ runs: [...runs.values()], prs, requests, lastError, events }) };

if (require.main === module) (async () => {
  if (process.argv.includes('--test-popup')) return popup('Magician Hub', 'Popups are working.');
  server.on('error', e => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.log(`Magician Hub is already running: ${HUB_URL}`);   // started twice: open the one that is running
    if (!HOSTED && cfg.openOnStart && !process.env.HUB_NO_OPEN) exec(`start "" "${HUB_URL}"`);
    process.exit(0);
  });
  server.listen(PORT, HOST, () => console.log(`Magician Hub on ${HOST}:${PORT}${HOSTED ? ' (hosted)' : ''}`));
  if (HOSTED) {
    token = process.env.GITHUB_TOKEN;
    if (!REQUIRE_SIGNIN) console.warn('REQUIRE_SIGNIN=false: keep this server reachable only inside the company network.');
  } else {
    email = (cfg.email || await git(['config', 'user.email'])).toLowerCase() || null;
    token = await gitLogin();
    if (!token) {
      lastError = 'No GitHub login found. Clone or pull any MRRSoft repo once with Git, then restart the hub.';
      return console.error(lastError);
    }
    console.log(`Watching builds for ${email || 'everyone'}`);
  }
  poll();
  setInterval(poll, cfg.pollSeconds * 1000);
  if (process.env.TEAMS_WEBHOOK_URL) setInterval(() => nudge().catch(e => console.error('Teams nudge failed:', e.message)), 30000);
  setInterval(() => timeReminder().catch(e => console.error('Time reminder:', e.message)), 30000);
  setInterval(() => runJobs().catch(e => console.error('Nudges:', e.message)), 30000);   // 12:00 PR nudges, 18:00 day check, Mon 10:00 stale PRs
  setInterval(() => { if (teamSyncDue()) syncTeam(); }, 10 * 60000);   // daily team refresh from Jira, checked every 10 minutes
  setTimeout(() => { if (teamSyncDue()) syncTeam(); }, team.size ? 2 * 60000 : 20000);   // soon after start (first run: right away), once Jira is connected
  if (!HOSTED && cfg.openOnStart && !process.env.HUB_NO_OPEN) exec(`start "" "${HUB_URL}"`);   // not when starting with Windows
})();
