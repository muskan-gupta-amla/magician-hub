// Every test runs with its own empty data folder and this made-up team (the real team comes from Jira).
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
const team = ['asha.rao', 'ben.kumar', 'chitra.iyer', 'dev.patel', 'esha.singh', 'farhan.ali'].map(n => `${n}@amla.io`);
fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ at: new Date().toISOString(), team }));
process.env.MAGICIAN_HUB_DATA = dir;
module.exports = { team };
