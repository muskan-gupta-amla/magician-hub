// Connecting Jira with a personal API token pasted on the page (PC only).
// Run: node --test test/jira-token.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
require('./fake-team');   // own data folder, made-up team
process.env.HUB_JIRA = 'off';   // start without Jira; connecting turns it on
process.env.HUB_ACLI = 'no-such-acli-command';   // never run the real Atlassian CLI
const test = require('node:test');
const assert = require('node:assert');
const hub = require('../hub.js');

const GOOD = 'good-token-123';
let expired = false;   // flip to make Jira reject the saved token
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (url.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  const auth = Buffer.from((opts.headers.Authorization || '').replace('Basic ', ''), 'base64').toString();
  if (url.endsWith('/rest/api/3/myself')) return auth === `asha.rao@amla.io:${GOOD}` ? reply({ displayName: 'Asha Rao' }) : reply({}, 401);
  if (url.includes('/rest/api/3/search/jql')) return expired ? reply({}, 401) : reply({ issues: [] });
  throw new Error('Unexpected call in test: ' + url);
};

let port;
hub.setSession({ token: 'test', email: 'asha.rao@amla.io' });
test.before(() => new Promise(r => hub.server.listen(0, '127.0.0.1', () => { port = hub.server.address().port; r(); })));
test.after(() => hub.server.close());
const post = (body, headers = { 'X-Magician-Hub': '1' }, method = 'POST', host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/jira-token', method,
    headers: { 'Content-Type': 'application/json', ...headers, ...(host ? { Host: host } : {}) } }, res => {
    let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const saved = () => path.join(process.env.MAGICIAN_HUB_DATA, 'jira.json');

test('refused unless it comes from the hub page on this PC', async () => {
  assert.equal((await post({ email: 'asha.rao@amla.io', token: GOOD }, {})).status, 403);   // no hub header: another website
  assert.equal((await post(null, { 'X-Magician-Hub': '1' }, 'GET')).status, 403);
  assert.equal((await post({ email: 'asha.rao@amla.io', token: GOOD }, { 'X-Magician-Hub': '1' }, 'POST', 'evil.example.com')).status, 403);
  assert.equal(fs.existsSync(saved()), false);
});

test('a wrong token is rejected with a clear message and nothing is saved', async () => {
  const r = await post({ email: 'asha.rao@amla.io', token: 'wrong' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /did not accept/);
  assert.equal(fs.existsSync(saved()), false);
});

test('a good token is checked, saved in the profile folder, switches Jira on, and is never sent back', async () => {
  const r = await post({ email: 'Asha.Rao@amla.io', token: ` ${GOOD} ` });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { ok: true, name: 'Asha Rao' });
  assert.ok(!r.text.includes(GOOD));
  assert.deepEqual(JSON.parse(fs.readFileSync(saved(), 'utf8')), { email: 'asha.rao@amla.io', token: GOOD });
  const state = await (await realFetch(`http://127.0.0.1:${port}/api/state`)).text();
  assert.equal(JSON.parse(state).jiraOn, true);
  assert.ok(!state.includes(GOOD));
});

test('when the saved token stops working, the page is told to ask for a new one', async () => {
  expired = true;
  await hub.pollJira();
  const s = await (await realFetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(s.jiraNeedsToken, true);   // the Time page shows the paste box again
  expired = false;
  const r = await post({ email: 'asha.rao@amla.io', token: GOOD });   // pasting a working token clears it
  assert.equal(r.status, 200);
  assert.equal((await (await realFetch(`http://127.0.0.1:${port}/api/state`)).json()).jiraNeedsToken, false);
});
