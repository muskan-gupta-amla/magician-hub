// Popup test against a simulated GitHub: your build starts, passes, a second one fails,
// a teammate builds, and someone requests your review.
// Run: node --test test/popups.test.js     (SHOW_POPUPS=1 also shows the real Windows popups)
process.env.HUB_JIRA = 'off';   // these tests are about GitHub; never call the real Jira
require('./fake-team');   // own data folder, made-up team
const test = require('node:test');
const assert = require('node:assert');
const hub = require('../hub.js');

const OWNER = 'MRRSoft', API = 'znode10-api-migration', ADMIN = 'znode10-admin-migration';
const world = { runs: [], adminPulls: [], reviews: {} };   // what the fake GitHub returns right now

const run = (id, status, conclusion, branch, who = 'asha-rao-amla', email = 'asha.rao@amla.io') => ({
  id, status, conclusion, head_branch: branch, name: 'Build and Test', event: 'push',
  html_url: `https://github.com/${OWNER}/${API}/actions/runs/${id}`,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  actor: { login: who, type: 'User' }, head_commit: { author: { email } }
});
// Dev's open PR; asking Asha to review it is a review request.
const teammatePr = reviewers => ({
  number: 9999, title: 'Z10-41302: Admin changes related to Cart page', user: { login: 'dev-patel-amla' },
  html_url: `https://github.com/${OWNER}/${ADMIN}/pull/9999`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  base: { ref: 'int' }, head: { ref: 'Z10-41302-cart-page-int' }, draft: false, requested_reviewers: reviewers.map(login => ({ login }))
});

// Fake GitHub API: answers the routes the hub calls.
let loginExpired = false;   // GitHub rejects the old login until the hub reads a fresh one
globalThis.fetch = async (url, opts = {}) => {
  const p = new URL(url).pathname;
  const reply = data => ({ ok: true, status: 200, json: async () => data });
  if (loginExpired && opts.headers && opts.headers.Authorization === 'Bearer test') return { ok: false, status: 401, json: async () => ({}) };
  let m;
  if ((m = /\/actions\/runs\/(\d+)\/jobs$/.exec(p))) {
    return reply({ jobs: [{ id: 9001, conclusion: 'failure', steps: [{ name: 'Build', conclusion: 'failure' }] }] });
  }
  if (/\/check-runs\/\d+\/annotations$/.test(p)) {
    return reply([{ annotation_level: 'failure', path: 'Znode.Admin/Controllers/StoreController.cs', start_line: 212,
      message: "CS0103: The name 'portalId' does not exist in the current context" }]);
  }
  if ((m = /\/repos\/[^/]+\/([^/]+)\/actions\/runs\/(\d+)$/.exec(p))) return reply(world.runs.find(r => r.id === +m[2]));
  if ((m = /\/repos\/[^/]+\/([^/]+)\/actions\/runs$/.exec(p))) return reply({ workflow_runs: m[1] === API ? world.runs : [] });
  if ((m = /\/repos\/[^/]+\/([^/]+)\/pulls$/.exec(p))) return reply(m[1] === ADMIN ? world.adminPulls : []);
  if ((m = /\/pulls\/(\d+)\/reviews$/.exec(p))) return reply(world.reviews[m[1]] || []);
  throw new Error('Unexpected GitHub call in test: ' + p);
};

const shown = [];
const SHOW = process.env.SHOW_POPUPS === '1';
hub.hooks.popup = (title, body) => { shown.push(`${title} | ${body}`); if (SHOW) hub.popup(title, body); };
hub.setSession({ token: 'test', email: 'asha.rao@amla.io' });

async function step() { shown.length = 0; await hub.poll(); assert.equal(hub.state().lastError, null); return [...shown]; }

test('first check only loads data, no popups', async () => {
  world.runs = [run(100, 'completed', 'success', 'Z10-40000-old-build-int')];
  world.adminPulls = [teammatePr([])];
  assert.deepEqual(await step(), []);
});

test('your build starts and a review is requested; a teammate build makes no popup', async () => {
  world.runs.unshift(run(101, 'in_progress', null, 'Z10-37238-postmessage-origin-int'),
    run(201, 'in_progress', null, 'Z10-41302-cart-page-int', 'dev-patel-amla', 'dev.patel@amla.io'));
  world.adminPulls = [teammatePr(['asha-rao-amla'])];
  assert.deepEqual(await step(), [
    `api Z10-37238: build started | Z10-37238-postmessage-origin-int · Build and Test`,
    `Review requested: ${ADMIN} #9999 | dev-patel-amla · Z10-41302: Admin changes related to Cart page`
  ]);
});

test('your build passes and a second one starts', async () => {
  Object.assign(world.runs.find(r => r.id === 101), { status: 'completed', conclusion: 'success' });
  world.runs.unshift(run(102, 'in_progress', null, 'Z10-37238-postmessage-origin-hotfix'));
  assert.deepEqual(await step(), [
    `api Z10-37238: build started | Z10-37238-postmessage-origin-hotfix · Build and Test`,
    `api Z10-37238: build passed | Z10-37238-postmessage-origin-int · Build and Test`
  ]);
});

test('your build fails and the popup says why', async () => {
  Object.assign(world.runs.find(r => r.id === 102), { status: 'completed', conclusion: 'failure' });
  assert.deepEqual(await step(), [
    `api Z10-37238: build failed | Z10-37238-postmessage-origin-hotfix · Step: Build · StoreController.cs:212 CS0103: The name 'portalId' does not exist in the current context`
  ]);
});

test('nothing changes, so no repeat popups', async () => {
  assert.deepEqual(await step(), []);
});

test('events are kept for every team member, each with a link, for browser alerts', () => {
  const events = hub.state().events;
  assert.deepEqual(events.map(e => [e.person.split('@')[0], e.url.split(`${OWNER}/`)[1]]), [
    ['asha.rao', `${API}/actions/runs/101`],
    ['dev.patel', `${API}/actions/runs/201`],   // teammate: no Windows popup for you, an alert on their own page
    ['asha.rao', `${ADMIN}/pull/9999`],
    ['asha.rao', `${API}/actions/runs/102`],
    ['asha.rao', `${API}/actions/runs/101`],
    ['asha.rao', `${API}/actions/runs/102`]
  ]);
  assert.ok(events.every((e, i) => !i || e.at >= events[i - 1].at));
});

test('your PR is approved, then gets changes requested: a popup each time', async () => {
  const later = s => new Date(Date.now() + s * 1000).toISOString();
  const mine = { ...teammatePr([]), number: 8398, title: 'Z10-37238: Validate origin', user: { login: 'asha-rao-amla' },
    html_url: `https://github.com/${OWNER}/${ADMIN}/pull/8398`, head: { ref: 'Z10-37238-origin-int' } };
  world.adminPulls = [mine];
  assert.deepEqual(await step(), []);   // first time the hub sees it: nothing to announce
  world.reviews[8398] = [{ user: { login: 'esha-singh-amla', type: 'User' }, state: 'APPROVED' }];
  world.adminPulls = [{ ...mine, updated_at: later(5) }];
  assert.deepEqual(await step(), [`Approved: ${ADMIN} #8398 | Z10-37238: Validate origin`]);
  world.reviews[8398].push({ user: { login: 'farhan-ali-amla', type: 'User' }, state: 'CHANGES_REQUESTED' });
  world.adminPulls = [{ ...mine, updated_at: later(10) }];
  assert.deepEqual(await step(), [`Changes requested: ${ADMIN} #8398 | Z10-37238: Validate origin`]);
  world.adminPulls = [teammatePr(['asha-rao-amla'])];   // back to the earlier scenario
  await step();
});

test('an expired GitHub login is replaced by a fresh one from Git without a restart', async () => {
  loginExpired = true;
  hub.hooks.gitLogin = async () => 'fresh-login';
  shown.length = 0; await hub.poll();
  assert.equal(hub.state().lastError, null);   // fresh login picked up
  assert.equal((await step()).length, 0);      // next poll works with it
  // Git still has the same rejected login: tell the person what to do
  hub.setSession({ token: 'test', email: 'asha.rao@amla.io' }); hub.hooks.gitLogin = async () => 'test';
  await hub.poll();
  assert.match(hub.state().lastError, /GitHub login expired/);
  loginExpired = false; await hub.poll();
});

test('the same review request is not announced twice; a new reviewer is', async () => {
  assert.deepEqual(await step(), []);
  world.adminPulls = [teammatePr(['asha-rao-amla', 'ben-kumar-amla'])];
  assert.deepEqual(await step(), []);   // Ben's request: an event for Ben, no Windows popup for you
  assert.equal(hub.state().events.at(-1).person, 'ben.kumar@amla.io');
});
