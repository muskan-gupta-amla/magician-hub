// Standup, release notes, impact check and the Teams nudge, against a simulated GitHub.
// Run: node --test test/tools.test.js
process.env.JIRA_EMAIL = 'hub@amla.io';   // Jira through its API, answered by the fake below
process.env.JIRA_API_TOKEN = 'jira-test-token';
require('./fake-team');   // own data folder, made-up team
const test = require('node:test');
const assert = require('node:assert');
const hub = require('../hub.js');

const OWNER = 'MRRSoft', API = 'znode10-api-migration', DB = 'znode10-multifront-db', ADMIN = 'znode10-admin-migration';
const now = new Date().toISOString(), fiveDaysAgo = new Date(Date.now() - 5 * 864e5).toISOString();
const pull = (number, title, author, reviewers, created = now) => ({
  number, title, user: { login: author }, html_url: `https://github.com/${OWNER}/${API}/pull/${number}`,
  created_at: created, updated_at: now, base: { ref: 'int' }, head: { ref: `Z10-${number}-change-int` }, draft: false,
  requested_reviewers: reviewers.map(login => ({ login }))
});
const issue = (number, title, author, repo, state, merged) => ({
  number, title, user: { login: author }, html_url: `https://github.com/${OWNER}/${repo}/pull/${number}`, created_at: now,
  repository_url: `https://api.github.com/repos/${OWNER}/${repo}`, state, pull_request: { merged_at: merged ? now : null }
});
const apiPulls = [
  pull(1, 'Z10-1: Approved change', 'ben-kumar-amla', []),
  pull(2, 'Z10-2: Change with no reviewer', 'asha-rao-amla', []),
  pull(3, 'Z10-3: Waiting for review', 'chitra-iyer-amla', ['asha-rao-amla'], fiveDaysAgo)
];
const posted = [], worklogs = [], estimates = [], teamsCards = [];   // Teams posts and time logged, as the fake services received them
let teamAnswer = [];                // assignees the fake Jira returns for the Team = Magicians search

const ICS_URL = 'https://outlook.office365.com/owa/calendar/abc/def/calendar.ics', TEAMS_HOOK = 'https://prod-01.westus.logic.azure.com/workflows/x/triggers/manual/paths/invoke';
const ymd = d => d.toLocaleDateString('en-CA').replace(/-/g, '');
function icsToday() {   // a daily stand-up (Teams link), one meeting today, a cancelled one, one yesterday
  const today = ymd(new Date()), y = new Date(); y.setDate(y.getDate() - 1);
  return ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Daily stand-up', 'DTSTART;TZID=India Standard Time:20260101T100000',
    'DTEND;TZID=India Standard Time:20260101T101500', 'RRULE:FREQ=DAILY;INTERVAL=1', 'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/abc',
    'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Sprint review', `DTSTART:${today}T150000`, `DTEND:${today}T160000`, 'LOCATION:Room 2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Dropped', `DTSTART:${today}T120000`, 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Yesterday only', `DTSTART:${ymd(y)}T090000`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const realFetch = globalThis.fetch;   // the test's own calls to the hub stay real
globalThis.fetch = async (url, opts) => {
  if (url.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  if (url.startsWith('https://teams.test/')) { posted.push(JSON.parse(opts.body)); return reply({}); }
  if (url === ICS_URL) return { ok: true, status: 200, text: async () => icsToday() };   // a published Outlook calendar
  if (url === TEAMS_HOOK) { teamsCards.push(JSON.parse(opts.body)); return reply({}, 202); }
  if (/\/rest\/api\/3\/issue\/[\w-]+\/worklog$/.test(url) && opts.method === 'POST') {
    const key = url.split('/issue/')[1].split('/')[0];
    if (key === 'Z10-404') return reply({}, 404);
    if (key === 'Z10-400') return reply({ errorMessages: [], errors: { timeLogged: 'Cannot log work on a closed period.' } }, 400);
    worklogs.push({ key, ...JSON.parse(opts.body) });
    return reply({ id: '1' }, 201);
  }
  if (url.includes('/rest/api/3/mypermissions?issueKey=')) {   // Z10-32 is a Story where Jira doesn't let you log time
    return reply({ permissions: { WORK_ON_ISSUES: { havePermission: !url.includes('issueKey=Z10-32&') } } });
  }
  if (/\/rest\/api\/3\/issue\/Z10-(32|33)\?fields=timetracking/.test(url)) {   // one ticket's time, for the Log time form
    const estimated = url.includes('Z10-33');
    return reply({ key: 'Z10-32', fields: { issuetype: { name: estimated ? 'Task' : 'Story' }, status: { name: 'Analysis' },
      timetracking: estimated ? { originalEstimateSeconds: 28800, timeSpentSeconds: 36000, remainingEstimateSeconds: 0 } : {} },
      editmeta: { fields: { timetracking: {} } } });
  }
  if (/\/rest\/api\/3\/issue\/Z10-(32|99)$/.test(url) && opts.method === 'PUT') {
    if (url.endsWith('Z10-99')) return reply({ errorMessages: [], errors: { timetracking: 'Field timetracking cannot be set.' } }, 400);
    estimates.push({ key: 'Z10-32', ...JSON.parse(opts.body) });
    return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
  }
  if (url.startsWith('https://amla.atlassian.net/rest/api/3/issue/Z10-7/worklog?startedAfter=')) {
    const ago = days => new Date(Date.now() - days * 864e5).toISOString();
    return reply({ total: 2, worklogs: [
      { author: { emailAddress: 'asha.rao@amla.io' }, started: ago(1.5), timeSpentSeconds: 3600, comment: 'Standup meeting' },
      { author: { emailAddress: 'asha.rao@amla.io' }, started: ago(2), timeSpentSeconds: 1800, comment: 'Small fix' }] });
  }
  if (url.startsWith('https://amla.atlassian.net/rest/api/3/search/jql')) {
    assert.match(opts.headers.Authorization, /^Basic /);
    const jql = new URL(url).searchParams.get('jql');
    const issue = (key, summary, status, cat, assignee) => ({ key, fields: { summary, status: { name: status, statusCategory: { key: cat } },
      priority: { name: 'Medium' }, issuetype: { name: 'Bug' }, assignee: assignee ? { emailAddress: assignee } : null } });
    const all = [issue('Z10-1', 'Approved change', 'Done', 'done', 'ben.kumar@amla.io'), issue('Z10-2', 'Change with no reviewer', 'In Progress', 'indeterminate', 'asha.rao@amla.io'),
      issue('Z10-3', 'Waiting for review', 'Code Review', 'indeterminate', 'chitra.iyer@amla.io'), issue('Z10-50', 'Next task', 'To Do', 'new', 'asha.rao@amla.io'),
      issue('Z10-10', 'Tax rounding on orders', 'Done', 'done', null), issue('Z10-11', 'Store logo in emails', 'QA', 'indeterminate', null),
      issue('Z10-7', 'Fixed earlier', 'Done', 'done', 'asha.rao@amla.io')];
    if (jql.startsWith('assignee = currentUser()')) return reply({ issues: [] });
    if (jql.startsWith('cf[10117] = "Magicians"')) return reply({ issues: teamAnswer.map((a, i) => issue(`Z10-${900 + i}`, 'Team ticket', 'Done', 'done', a)) });
    if (jql.includes('sprint in openSprints()')) {   // the Daily Scrum's sprint card
      const sprint = { id: 20, name: 'Magicians Sprint 20', state: 'active', startDate: '2026-10-05T00:00:00Z', endDate: '2026-10-26T00:00:00Z', goal: '' };
      return reply({ issues: [['Z10-2', 'indeterminate'], ['Z10-7', 'done'], ['Z10-50', 'new']].map(([key, cat]) =>
        ({ key, fields: { ...all.find(i => i.key === key).fields, status: { name: cat, statusCategory: { key: cat } }, customfield_10010: [sprint, { id: 19, state: 'closed' }] } })) });
    }
    if (jql.includes('statusCategoryChangedDate')) return reply({ issues: all.filter(i => i.key === 'Z10-2') });
    if (jql.startsWith('worklogAuthor = "asha.rao@amla.io"')) return reply({ issues: all.filter(i => ['Z10-2', 'Z10-7'].includes(i.key)) });
    if (new URL(url).searchParams.get('fields').includes('timetracking')) {
      const ago = days => new Date(Date.now() - days * 864e5).toISOString(), log = (who, days, seconds, text) =>
        ({ author: { emailAddress: who }, started: ago(days), timeSpentSeconds: seconds, comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
      const time = {
        'Z10-2': { timetracking: { originalEstimateSeconds: 28800, timeSpentSeconds: 36000, remainingEstimateSeconds: 0 },
          worklog: { total: 3, worklogs: [log('asha.rao@amla.io', 0.001, 7200, 'Fixed tax rounding'), log('asha.rao@amla.io', 1, 10800, 'Analysis'), log('ben.kumar@amla.io', 1, 3600, 'Review')] } },
        'Z10-50': { timetracking: { originalEstimateSeconds: 14400, timeSpentSeconds: 3600, remainingEstimateSeconds: 10800 },
          worklog: { total: 1, worklogs: [log('asha.rao@amla.io', 20, 3600, 'Too old for the 14 days')] } },
        // A busy ticket: 25 logs, Jira inlines only the oldest one here, so the hub must read the rest by date
        'Z10-7': { timetracking: {}, worklog: { total: 25, worklogs: [log('asha.rao@amla.io', 60, 1800, 'Old')] } } };
      const keys = /key in \(([^)]*)\)/.exec(jql)[1].split(',');
      return reply({ issues: keys.filter(k => time[k]).map(k => ({ key: k, fields: time[k] })) });
    }
    const who = /^assignee = "([^"]+)"/.exec(jql);
    if (who) return reply({ issues: all.filter(i => i.fields.assignee && i.fields.assignee.emailAddress === who[1] && i.fields.status.statusCategory.key !== 'done') });
    const keys = /key in \(([^)]*)\)/.exec(jql)[1].split(',');
    if (keys.some(k => !all.find(i => i.key === k))) return reply({ errorMessages: ['An issue with key does not exist'] }, 400);
    return reply({ issues: all.filter(i => keys.includes(i.key)) });
  }
  const u = new URL(url), p = u.pathname, q = u.searchParams.get('q') || '';
  let m;
  if (/\/actions\/runs$/.test(p)) return reply({ workflow_runs: [] });
  if ((m = /\/repos\/[^/]+\/([^/]+)\/pulls$/.exec(p))) return reply(m[1] === API ? apiPulls : []);
  if (p === `/repos/${OWNER}/${API}/pulls/1/reviews`) return reply([{ user: { login: 'esha-singh-amla', type: 'User' }, state: 'APPROVED', submitted_at: new Date(Date.now() - 7 * 864e5).toISOString() }]);
  if (/\/reviews$/.test(p)) return reply([]);
  if (p === '/search/issues') {
    if (q.includes('reviewed-by:asha-rao-amla')) return reply({ items: [issue(3, 'Z10-3: Waiting for review', 'chitra-iyer-amla', API, 'open')] });
    if (q.includes('author:asha-rao-amla')) return reply({ items: [issue(2, 'Z10-2: Change with no reviewer', 'asha-rao-amla', API, 'open'), issue(5, 'Z10-5: Fix store logo', 'asha-rao-amla', ADMIN, 'closed', true)] });
    if (q.startsWith('Z10-77 is:pr')) {
      if (!q.includes('is:open')) throw new Error('impact check must only look at open PRs: ' + q);
      return reply({ items: [issue(9, 'Z10-77: Order tax rounding', 'asha-rao-amla', DB, 'open')] });
    }
    return reply({ items: [] });
  }
  if ((m = /\/repos\/[^/]+\/([^/]+)\/compare\//.exec(p))) {
    if (m[1] === ADMIN) return reply({ message: 'Not Found' }, 404);
    if (m[1] !== API) return reply({ total_commits: 0, commits: [] });
    return reply({ total_commits: 3, commits: [
      { commit: { message: 'Z10-10: Fix tax rounding (#120)' } },
      { commit: { message: 'Merge pull request #121 from MRRSoft/Z10-11-logo\n\nZ10-11: Show store logo in emails' } },
      { commit: { message: 'downmerge-int-to-dev10 (#122)\n\n* Z10-10: Fix tax rounding\n* Z10LMC-4008: Prevent duplicate products' } }] });
  }
  if (p === '/search/commits') return reply({ items: [] });
  if (p === `/repos/${OWNER}/${DB}/pulls/9`) return reply({ state: 'open', merged_at: null });
  if (p === `/repos/${OWNER}/${DB}/pulls/10`) return reply({ state: 'closed', merged_at: null });
  if (p === `/repos/${OWNER}/${DB}/pulls/11`) return reply({ state: 'closed', merged_at: now });
  if (p === `/repos/${OWNER}/${DB}/pulls/9/files`) {
    return reply([{ filename: 'Znode.Database/Procedures/Znode_GetOrderDetails.sql', patch: '-ALTER PROCEDURE [dbo].[Znode_GetOrderDetails]\n+ALTER PROCEDURE [dbo].[Znode_GetOrderDetails] @IncludeTax BIT' },
      { filename: 'src/Models/OrderModel.cs', patch: '' }, { filename: 'src/Middleware/RequestMiddleware.cs', patch: '' }, { filename: 'README.md', patch: '' }]);
  }
  if (p === `/repos/${OWNER}/${API}/pulls/12`) return reply({ state: 'open', merged_at: null });
  if (p === `/repos/${OWNER}/${API}/pulls/12/files`) {   // one PR with every kind of risky change
    return reply([
      { filename: 'Db/Procedures/Znode_GetCart.sql', additions: 3, deletions: 1, patch: ' ALTER PROCEDURE [dbo].[Znode_GetCart]\n-  @PortalId INT,\n+  @PortalId INT,\n+  @IncludeTax BIT\n+  ,@Locale NVARCHAR(10) = NULL' },
      { filename: 'Db/Scripts/alter.sql', additions: 2, deletions: 0, patch: '+ALTER TABLE ZnodeOrder DROP COLUMN TaxAmount\n+DROP VIEW IF EXISTS [dbo].[View_Orders]' },
      { filename: 'Api/Models/CartModel.cs', additions: 1, deletions: 1, patch: '-    public decimal TaxAmount { get; set; }\n+    public decimal Tax { get; set; }' },
      { filename: 'Api/Controllers/CartController.cs', additions: 1, deletions: 1, patch: '-    [Route("v2/carts/{cartId}")]\n+    [Route("v2/carts/{cartId}/details")]' },
      { filename: 'Api/Services/ICartService.cs', additions: 1, deletions: 2, patch: '-    CartModel GetCart(int cartId);\n+    CartModel GetCart(int cartId, bool includeTax);\n-    void DeleteCart(int id);' },
      { filename: 'web/src/components/Cart.tsx', additions: 1, deletions: 1, patch: '-export const CartSummary = () => {\n+export const CartTotals = () => {' },
      { filename: 'Api/appsettings.json', additions: 1, deletions: 1, patch: '-  "ZnodeCacheMinutes": 10,\n+  "CacheMinutes": 10,' },
      { filename: 'Admin/Resources/Admin.resx', additions: 0, deletions: 1, patch: '-  <data name="LabelOldTitle" xml:space="preserve">' },
      { filename: 'Api/Helpers/OldHelper.cs', status: 'removed', additions: 0, deletions: 40, patch: '' },
      { filename: 'Api.Tests/CartServiceTests.cs', additions: 10, deletions: 0, patch: '+[Fact]' }]);
  }
  if (p === '/search/code') {
    if (q.replace(/"/g, '').startsWith('Znode_GetOrderDetails')) return reply({ items: [
      { repository: { name: API }, path: 'Services/OrderService.cs', html_url: 'https://github.com/x/1' },
      { repository: { name: API }, path: 'Scripts/Znode_GetOrderDetails.sql', html_url: 'https://github.com/x/3' },   // same name, its own copy
      { repository: { name: DB }, path: 'Znode.Database/Procedures/Znode_GetOrderDetails.sql', html_url: 'https://github.com/x/2' }] });
    return reply({ message: 'rate limit' }, 403);
  }
  throw new Error('Unexpected GitHub call in test: ' + url);
};

let base;
hub.setSession({ token: 'test', email: 'asha.rao@amla.io' });
const popups = []; hub.hooks.popup = (title, body) => popups.push(`${title} | ${body}`);   // never show a real Windows popup
test.before(async () => {
  await hub.poll();
  assert.equal(hub.state().lastError, null);
  await new Promise(r => hub.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${hub.server.address().port}`;
});
test.after(() => hub.server.close());
const api = async (path, params) => { const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`); return { status: res.status, body: await res.json() }; };

test('standup: PRs authored and reviewed since the last working day, plus builds', async () => {
  const { status, body } = await api('/api/standup', { person: 'asha.rao@amla.io' });
  assert.equal(status, 200);
  assert.deepEqual(body.authored.map(p => `${p.number} ${p.state}`), ['2 open', '5 merged']);
  assert.deepEqual(body.reviewed.map(p => p.number), [3]);
  assert.deepEqual(body.builds, { passed: 0, failed: 0, failedList: [] });
  assert.deepEqual(body.moved.map(t => `${t.key} ${t.status}`), ['Z10-2 In Progress']);   // moved since the last working day
  assert.deepEqual(body.sprints.map(s => [s.name, s.done, s.doing, s.todo, s.tickets.length]), [['Magicians Sprint 20', 1, 1, 1, 3]]);
  assert.equal((await api('/api/standup', { person: 'stranger@example.com' })).status, 400);
});

test('Jira: the status of tickets named in PRs, and my own open tickets', async () => {
  const s = (await api('/api/state', {})).body;
  assert.equal(s.jiraOn, true);
  assert.deepEqual(['Z10-1', 'Z10-2', 'Z10-3'].map(k => s.jiraKeys[k] && s.jiraKeys[k].cat), ['done', 'indeterminate', 'indeterminate']);
  const mine = await api('/api/jira-mine', { person: 'asha.rao@amla.io' });
  assert.deepEqual(mine.body.tickets.map(t => `${t.key} ${t.status}`), ['Z10-2 In Progress', 'Z10-50 To Do']);
  assert.equal((await api('/api/jira-mine', { person: 'stranger@example.com' })).status, 400);
});

test('Jira on the ticket page', async () => {
  const { body } = await api('/api/fix', { key: 'https://amla.atlassian.net/browse/Z10-2' });
  assert.deepEqual([body.jira.key, body.jira.summary, body.jira.status, body.jira.assignee], ['Z10-2', 'Change with no reviewer', 'In Progress', 'asha.rao@amla.io']);
});

test('last working day is Friday on a Monday, yesterday otherwise', () => {
  assert.equal(hub.lastWorkday(new Date(2026, 9, 26, 12)), '2026-10-23');   // Monday
  assert.equal(hub.lastWorkday(new Date(2026, 9, 28, 12)), '2026-10-27');   // Wednesday
});

test('release notes: tickets across repos with clean titles, squashed down-merges and missing refs', async () => {
  const { status, body } = await api('/api/release', { from: 'v10.14.0.6', to: 'v10.14.0.0-hotfixes' });
  assert.equal(status, 200);
  assert.deepEqual(body.tickets.map(t => `${t.key} | ${t.title} | ${t.repos}`), [
    `Z10-10 | Fix tax rounding | ${API}`,
    `Z10-11 | Show store logo in emails | ${API}`,
    `Z10LMC-4008 | Prevent duplicate products | ${API}`
  ]);
  assert.deepEqual(body.missing, [ADMIN]);
  // Jira status and summary added; a key Jira doesn't know (Z10LMC-4008) is skipped, not an error
  assert.deepEqual(body.tickets.map(t => t.jira && `${t.jira.summary} (${t.jira.status})`), ['Tax rounding on orders (Done)', 'Store logo in emails (QA)', null]);
  assert.equal((await api('/api/release', { from: 'v1' })).status, 400);
});

test('impact check only searches the watched repos, and reuses results it already has', async () => {
  let seen = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (url.includes('/search/code')) seen.push(new URL(url).searchParams.get('q')); return prev(url, opts); };
  await api('/api/impact', { pr: `https://github.com/${OWNER}/${DB}/pull/9` });
  assert.ok(seen.length > 0 && seen.every(q => q.includes(`repo:${OWNER}/${API}`) && !q.includes('org:')), seen[0]);
  seen = [];
  await api('/api/impact', { pr: `https://github.com/${OWNER}/${DB}/pull/9` });
  globalThis.fetch = prev;
  // Znode_GetOrderDetails is cached; only OrderModel (rate limited, so not cached) is searched again.
  assert.deepEqual(seen.map(q => q.split(' ')[0].replace(/"/g, '')), ['OrderModel']);
});

test('impact check works in batches: "from" checks the next items only', async () => {
  const { body } = await api('/api/impact', { pr: `https://github.com/${OWNER}/${DB}/pull/9`, from: 1 });
  assert.equal(body.total, 2);
  assert.deepEqual([body.from, body.checkedTo], [1, 2]);
  assert.equal(body.findings[0].usages, undefined);   // not in this batch
  assert.ok('usages' in body.findings[1]);
});

test('impact check: finds the stored procedure and model, lists other-repo usages, handles the search limit', async () => {
  const { status, body } = await api('/api/impact', { pr: 'https://amla.atlassian.net/browse/Z10-77' });
  assert.equal(status, 200);
  assert.deepEqual(body.prs, [`${DB}#9`]);
  const sp = body.findings.find(n => n.kind === 'Database procedure');
  assert.equal(sp.name, 'Znode_GetOrderDetails');
  assert.deepEqual(sp.usages.map(u => `${u.repo} ${u.path}`), [`${API} Services/OrderService.cs`]);   // its own file is left out
  const model = body.findings.find(n => n.kind === 'C# data model');
  assert.equal(model.name, 'OrderModel');
  assert.equal(model.usages, null);   // search limit: shown as not checked
  assert.equal(body.limited, true);
  assert.equal(body.findings.length, 2);   // README.md and RequestMiddleware.cs (not a data model) are ignored
});

test('impact check finds every kind of risky change, with risk and reason', async () => {
  const { body } = await api('/api/impact', { pr: `https://github.com/${OWNER}/${API}/pull/12` });
  const got = body.findings.map(n => `${n.risk} | ${n.kind} | ${n.name}`);
  assert.deepEqual(got.slice().sort(), [
    'high | API route | v2/carts/{cartId}',
    'high | C# data model | CartModel',
    'high | Database column | TaxAmount',
    'high | Database object | View_Orders',
    'high | Database procedure | Znode_GetCart',
    'high | Deleted or renamed file | OldHelper',
    'high | Interface method | DeleteCart',
    'high | Interface method | GetCart',
    'low | Text resource | LabelOldTitle',
    'medium | Config setting | ZnodeCacheMinutes',
    'medium | Exported code | CartSummary'
  ]);
  assert.ok(got.indexOf(got.find(x => x.startsWith('low'))) === got.length - 1);   // riskiest first
  const proc = body.findings.find(n => n.kind === 'Database procedure');
  assert.match(proc.why, /New parameter without a default \(@IncludeTax\)/);   // @Locale has a default, so it is fine
  assert.match(body.findings.find(n => n.name === 'CartModel').why, /TaxAmount/);
  assert.equal(body.findings.find(n => n.kind === 'API route').search, 'v2/carts');
  assert.deepEqual([body.stats.files, body.stats.additions, body.stats.deletions, body.stats.tests], [10, 20, 48, 1]);
});

test('time: logs from the last 14 days and estimate vs logged on my open tickets', async () => {
  const { status, body } = await api('/api/time', { person: 'asha.rao@amla.io' });
  assert.equal(status, 200);
  assert.deepEqual(body.entries.map(e => `${e.key} ${e.seconds} ${e.comment}`),
    ['Z10-2 7200 Fixed tax rounding', 'Z10-2 10800 Analysis', 'Z10-7 3600 Standup meeting', 'Z10-7 1800 Small fix']);   // busy ticket read in full
  assert.deepEqual(body.tickets.map(t => `${t.key} ${t.estimate} ${t.spent} ${t.remaining}`), ['Z10-2 28800 36000 0', 'Z10-50 14400 3600 10800']);
  assert.deepEqual(body.partial, []);   // the API reads busy tickets' logs by date, so nothing is missing
  assert.equal(body.weekHours, 40);
  assert.equal((await api('/api/time', { person: 'stranger@example.com' })).status, 400);
});

test('impact check refuses closed and merged PRs', async () => {
  const closed = await api('/api/impact', { pr: `https://github.com/${OWNER}/${DB}/pull/10` });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.error, 'This PR is closed.');
  const merged = await api('/api/impact', { pr: `https://github.com/${OWNER}/${DB}/pull/11` });
  assert.equal(merged.body.error, 'This PR is already merged.');
});

test('Teams nudge: posts once per slot, only with a webhook, listing who needs what', async () => {
  const at10 = new Date(2026, 9, 23, 10, 0);
  assert.equal(await hub.nudge(at10), false);   // no webhook configured
  process.env.TEAMS_WEBHOOK_URL = 'https://teams.test/hook';
  assert.equal(await hub.nudge(new Date(2026, 9, 23, 11, 0)), false);   // not a nudge time
  assert.equal(await hub.nudge(at10), true);
  assert.equal(await hub.nudge(at10), false);   // same slot: no second post
  assert.equal(posted.length, 1);
  const text = posted[0].attachments[0].content.body[1].text;
  assert.match(text, /Ready to merge \(1\)[\s\S]*Z10-1: Approved change/);
  assert.match(text, /No reviewer \(1\)[\s\S]*Z10-2: Change with no reviewer/);
  assert.match(text, /Waiting for review over 3 days \(1\)[\s\S]*Z10-3: Waiting for review/);
  delete process.env.TEAMS_WEBHOOK_URL;
});

// --- Log time, Friday reminder, team list (these run last: the team test changes the team) ---
const postJson = (path, body, headers = { 'X-Magician-Hub': '1' }) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('time typed the way people type it', () => {
  assert.deepEqual(['2h 30m', '2.5', '2.5h', '45m', '1h', '8', 'abc', '', '2 hours'].map(hub.parseDuration),
    [9000, 9000, 9000, 2700, 3600, 28800, 0, 0, 0]);
});

test('log time: writes the worklog to Jira as you, with date and comment', async () => {
  const r = await postJson('/api/worklog', { key: 'Z10-2', time: '2h 30m', date: '2026-10-20', comment: 'Fixed tax rounding' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.key, r.body.seconds, r.body.day], ['Z10-2', 9000, '2026-10-20']);
  const w = worklogs.at(-1);
  assert.equal(w.timeSpentSeconds, 9000);
  assert.match(w.started, /^2026-10-20T09:00:00\.000[+-]\d{4}$/);
  assert.equal(w.comment.content[0].content[0].text, 'Fixed tax rounding');
  const s = (await api('/api/state', {})).body;
  assert.equal(s.canLogTime, 'hub@amla.io');   // whose time a Log writes
});

test('log time: refuses bad input, the future, unknown tickets and other websites', async () => {
  const before = worklogs.length;
  assert.match((await postJson('/api/worklog', { key: 'Z10-2', time: 'lots' })).body.error, /like 2h 30m/);
  assert.match((await postJson('/api/worklog', { key: 'Z10-2', time: '25h' })).body.error, /like 2h 30m/);
  assert.match((await postJson('/api/worklog', { key: 'not a key', time: '1h' })).body.error, /Pick a ticket/);
  assert.match((await postJson('/api/worklog', { key: 'Z10-2', time: '1h', date: '2999-01-01' })).body.error, /future/);
  assert.match((await postJson('/api/worklog', { key: 'Z10-404', time: '1h' })).body.error, /can't log time on Z10-404/);
  assert.equal((await postJson('/api/worklog', { key: 'Z10-400', time: '1h' })).body.error, 'Jira did not accept it: Cannot log work on a closed period.');   // Jira's own reason
  assert.equal((await postJson('/api/worklog', { key: 'Z10-2', time: '1h' }, {})).status, 403);   // no hub header: another website
  assert.equal(worklogs.length, before);
});

test('log time form: estimate, logged and remaining for a ticket; add an estimate when it has none', async () => {
  assert.deepEqual((await api('/api/ticket-time', { key: 'z10-33' })).body,
    { key: 'Z10-33', type: 'Task', status: 'Analysis', estimate: 28800, spent: 36000, remaining: 0, canSetEstimate: true, canLog: true });
  const none = (await api('/api/ticket-time', { key: 'Z10-32' })).body;
  assert.deepEqual([none.estimate, none.spent, none.canSetEstimate, none.canLog], [null, 0, true, false]);   // Jira: no logging here
  assert.match((await postJson('/api/estimate', { key: 'Z10-32', time: 'soon' })).body.error, /like 4h/);
  assert.deepEqual((await postJson('/api/estimate', { key: 'Z10-32', time: '4h 30m' })).body, { ok: true, key: 'Z10-32', seconds: 16200 });
  assert.deepEqual(estimates.at(-1), { key: 'Z10-32', fields: { timetracking: { originalEstimate: '4h 30m' } } });
  assert.equal((await postJson('/api/estimate', { key: 'Z10-99', time: '2h' })).body.error, 'Jira did not accept the estimate: Field timetracking cannot be set.');
  assert.equal((await postJson('/api/estimate', { key: 'Z10-32', time: '2h' }, {})).status, 403);   // no hub header: another website
  assert.equal(estimates.length, 1);
});

test('morning brief: today\'s Outlook meetings and Send to Teams, from links saved on this PC', async () => {
  assert.deepEqual((await api('/api/meetings', {})).body, { outlook: false, teams: false, meetings: null });
  assert.match((await postJson('/api/brief-link', { kind: 'ics', url: 'https://evil.example.com/calendar.ics' })).body.error, /ICS link/);
  assert.deepEqual((await postJson('/api/brief-link', { kind: 'ics', url: ICS_URL })).body, { ok: true, outlook: true, teams: false });
  const m = (await api('/api/meetings', {})).body;
  assert.deepEqual(m.meetings.map(x => [x.title, new Date(x.start).getHours(), x.join || x.location]),
    [['Daily stand-up', 10, 'https://teams.microsoft.com/l/meetup-join/abc'], ['Sprint review', 15, 'Room 2']]);
  assert.match((await postJson('/api/brief-send', { text: 'hi' })).body.error, /Connect Teams/);
  assert.match((await postJson('/api/brief-link', { kind: 'teams', url: 'https://evil.example.com/hook' })).body.error, /Workflows/);
  assert.deepEqual((await postJson('/api/brief-link', { kind: 'teams', url: TEAMS_HOOK })).body, { ok: true, outlook: true, teams: true });
  assert.deepEqual((await postJson('/api/brief-send', { text: '• Today: 2 things to do' })).body, { ok: true });
  assert.equal(teamsCards.at(-1).attachments[0].content.body[1].text, '• Today: 2 things to do');
  assert.equal((await postJson('/api/brief-send', { text: 'x' }, {})).status, 403);   // no hub header: another website
});

test('recurring meetings: weekly days, every other week, skipped dates', () => {
  const [ev] = hub.parseIcs(['BEGIN:VEVENT', 'UID:w', 'SUMMARY:Sync', 'DTSTART:20261005T113000', 'DTEND:20261005T120000',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', 'EXDATE:20261019T113000', 'END:VEVENT'].join('\n'));
  const on = (y, mo, d) => { const at = hub.occurrence(ev, new Date(y, mo - 1, d)); return at && at.getHours() + ':' + at.getMinutes(); };
  assert.deepEqual([on(2026, 10, 5), on(2026, 10, 7), on(2026, 10, 6), on(2026, 10, 12), on(2026, 10, 19), on(2026, 10, 21), on(2026, 9, 30)],
    ['11:30', '11:30', null, null, null, '11:30', null]);   // Mon, Wed, Tue, off week, skipped date, next on-week Wed, before the start
});

test('Friday reminder: once, on Friday at 16:00, when the week is under 40h', async () => {
  assert.deepEqual(await hub.timeReminder(new Date(2026, 9, 22, 16, 0)), []);   // Thursday
  assert.deepEqual(await hub.timeReminder(new Date(2026, 9, 23, 15, 0)), []);   // Friday, wrong time
  assert.deepEqual(await hub.timeReminder(new Date(2026, 9, 23, 16, 0)), ['asha.rao@amla.io']);
  assert.match(popups.at(-1), /^Time: \d+h( \d+m)? logged this week \| \d+h( \d+m)? still to log in Jira/);
  assert.deepEqual(await hub.timeReminder(new Date(2026, 9, 23, 16, 0)), []);   // already reminded today
});

test('12:00 PR nudges: once a day, each to the PR author only', async () => {
  const noon = new Date(2026, 9, 26, 12, 0), before = hub.state().events.length;
  assert.deepEqual(await hub.runJobs(new Date(2026, 9, 26, 11, 59)), {});
  assert.deepEqual(await hub.runJobs(noon), { prNudges: ['ben.kumar@amla.io'] });
  const sent = hub.state().events.slice(before).map(e => `${e.person} | ${e.title}`);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /^ben\.kumar@amla\.io \| Your PR api #1 was approved \d+ days ago\. Merge it$/);
  assert.equal(sent[1], 'ben.kumar@amla.io | Z10-1 is Done in Jira but its PR api #1 is still open');
  assert.deepEqual(await hub.runJobs(noon), {});   // already sent today
});

test('18:00 day check: weekdays only, when today is under 8h', async () => {
  const day = new Date(); day.setHours(18, 0, 0, 0);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1);   // the latest weekday
  const saturday = new Date(2026, 9, 24, 18, 0);
  assert.deepEqual(await hub.runJobs(saturday), { dayCheck: [] });   // weekend: nobody
  assert.deepEqual(await hub.runJobs(day), { dayCheck: ['asha.rao@amla.io'] });   // the fake logs are under 8h on any day
  assert.match(popups.at(-1), /^Today: \d+h( \d+m)? logged \| \d+h( \d+m)? to go/);
  assert.deepEqual(await hub.runJobs(day), {});
});

test('Monday 10:00 stale list: each author hears about their own PRs with no activity for 30+ days', async () => {
  const monday = new Date(Date.now() + 40 * 864e5); monday.setHours(10, 0, 0, 0);
  while (monday.getDay() !== 1) monday.setDate(monday.getDate() + 1);
  const tuesday = new Date(monday); tuesday.setDate(tuesday.getDate() + 1);
  assert.deepEqual(await hub.runJobs(tuesday), {});
  assert.deepEqual((await hub.runJobs(monday)).staleNudges.sort(), ['asha.rao@amla.io', 'ben.kumar@amla.io', 'chitra.iyer@amla.io']);
  assert.equal(popups.at(-1), 'You have 1 PR with no activity for 30+ days | Close or update them: api #2');
});

test('team list from Jira: a bad answer is ignored; a good one replaces the team and is saved', async () => {
  const fs = require('fs'), path = require('path');
  teamAnswer = [...Array(6)].map(() => 'alice.a@amla.io');   // only one person qualifies
  assert.equal(await hub.syncTeam(), null);
  assert.equal((await api('/api/state', {})).body.team.length, 6);
  teamAnswer = [...[...Array(6)].map(() => 'alice.a@amla.io'), ...[...Array(5)].map(() => 'bob.b@amla.io'),
    ...[...Array(7)].map(() => 'dave.d@amla.io'), ...[...Array(2)].map(() => 'carol.c@amla.io')];   // carol has only 2: not team
  assert.deepEqual(await hub.syncTeam(), ['alice.a@amla.io', 'bob.b@amla.io', 'dave.d@amla.io']);
  const s = (await api('/api/state', {})).body;
  assert.deepEqual([s.team, s.teamInfo.source], [['alice.a@amla.io', 'bob.b@amla.io', 'dave.d@amla.io'], 'jira']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.MAGICIAN_HUB_DATA, 'team.json'), 'utf8')).team, s.team);
});
