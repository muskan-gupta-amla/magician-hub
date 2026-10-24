// Hosted mode: the hub must not show data unless the request came through the company sign-in.
// Run: node --test test/hosted.test.js
process.env.GITHUB_TOKEN = 'test-token';   // hosted mode is chosen when the hub is loaded
process.env.HUB_JIRA = 'off';
require('./fake-team');   // own data folder, made-up team
const test = require('node:test');
const assert = require('node:assert');
const hub = require('../hub.js');

let base;
test.before(() => new Promise(r => hub.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${hub.server.address().port}`; r(); })));
test.after(() => hub.server.close());
const get = (path, email) => fetch(base + path, { headers: email ? { 'X-MS-CLIENT-PRINCIPAL-NAME': email } : {} });

test('no sign-in: data and page are refused', async () => {
  assert.equal((await get('/api/state')).status, 401);
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/api/fix?key=Z10-1')).status, 401);
});

test('health check works without sign-in and returns no data', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('signed-in team member: the hub knows who is looking', async () => {
  const d = await (await get('/api/state', 'Asha.Rao@amla.io')).json();
  assert.equal(d.hosted, true);
  assert.equal(d.signedIn, true);
  assert.equal(d.viewer, 'asha.rao@amla.io');
});

test('the team server never takes a personal Jira token', async () => {
  const res = await fetch(base + '/api/jira-token', { method: 'POST', body: '{}',
    headers: { 'X-MS-CLIENT-PRINCIPAL-NAME': 'asha.rao@amla.io', 'X-Magician-Hub': '1', 'Content-Type': 'application/json' } });
  assert.equal(res.status, 403);
});

test('signed-in person outside the team can view, but nothing is personal', async () => {
  const d = await (await get('/api/state', 'someone.else@amla.io')).json();
  assert.equal(d.viewer, null);
});
