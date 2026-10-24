// Starts Magician Hub in the background (it keeps running after Claude closes) and opens the page.
// Used by the plugin's /magician-hub:setup and /magician-hub:start.
//   node launch.js                 start, or just open the page if it is already running
//   node launch.js --restart       stop the running hub and start this version (after a plugin update)
//   node launch.js --no-open       start without opening the page (start with Windows)
//   node launch.js --check         what is installed, nothing started
//   node launch.js --autostart on|off   start with Windows, or not
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const URL_ = `http://localhost:${cfg.port}`;
const DATA_DIR = process.env.MAGICIAN_HUB_DATA || path.join(process.env.APPDATA || os.homedir(), 'MagicianHub');
const STARTUP = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Magician Hub.cmd');
const args = process.argv.slice(2), has = a => args.includes(a);

const health = () => fetch(`${URL_}/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false);
const run = (file, a) => { try { return execFileSync(file, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const openPage = () => spawn('cmd', ['/c', 'start', '', URL_], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

// A launcher in the data folder that always runs the newest installed version (plugin updates add a new folder).
function writeLauncher() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const versions = path.dirname(ROOT), cached = /[\\/]plugins[\\/]cache[\\/]/i.test(ROOT);
  const file = path.join(DATA_DIR, 'start-hub.cmd');
  fs.writeFileSync(file, ['@echo off',
    `set "HUB=${ROOT}"`,
    cached ? `for /f "delims=" %%d in ('dir /b /ad /o:d "${versions}" 2^>nul') do if exist "${versions}\\%%d\\hub.js" set "HUB=${versions}\\%%d"` : 'rem not a plugin install: always this folder',
    'node "%HUB%\\scripts\\launch.js" %*', ''].join('\r\n'));
  return file;
}

function stopRunning() {
  const line = (run('netstat', ['-ano']) || '').split(/\r?\n/).find(l => new RegExp(`:${cfg.port}\\s.*LISTENING`).test(l));
  const pid = line && line.trim().split(/\s+/).pop();
  if (pid && /^\d+$/.test(pid)) run('taskkill', ['/PID', pid, '/F']);
}

async function start() {
  if (has('--restart')) { stopRunning(); for (let i = 0; i < 20 && await health(); i++) await new Promise(r => setTimeout(r, 250)); }
  else if (await health()) { if (!has('--no-open')) openPage(); return console.log(`Magician Hub is running: ${URL_}`); }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'hub.log'), 'a');
  spawn(process.execPath, [path.join(ROOT, 'hub.js')], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, ...(has('--no-open') ? { HUB_NO_OPEN: '1' } : {}) } }).unref();
  for (let i = 0; i < 40; i++) {
    if (await health()) return console.log(`Magician Hub is running: ${URL_} (log: ${path.join(DATA_DIR, 'hub.log')})`);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`Magician Hub did not start. Last lines of ${path.join(DATA_DIR, 'hub.log')}:\n` +
    fs.readFileSync(path.join(DATA_DIR, 'hub.log'), 'utf8').split(/\r?\n/).slice(-8).join('\n'));
  process.exitCode = 1;
}

async function check() {
  const major = +process.versions.node.split('.')[0];
  const git = run('git', ['--version']), email = run('git', ['config', 'user.email']), acli = run('acli', ['--version']);
  console.log([
    `Node.js: ${process.versions.node} ${major >= 18 ? 'OK' : 'TOO OLD, install Node.js 18 or newer from https://nodejs.org'}`,
    `Git: ${git ? git.replace('git version ', '') + ' OK' : 'MISSING, install Git for Windows from https://git-scm.com'}`,
    `Git email: ${email || 'NOT SET, run: git config --global user.email "you@amla.io"'}`,
    `Atlassian CLI (optional, for Jira): ${acli ? 'OK' : 'not installed (Jira still works: paste your Jira API token on the Time page)'}`,
    `Start with Windows: ${fs.existsSync(STARTUP) ? 'on' : 'off'}`,
    `Running now: ${await health() ? 'yes, ' + URL_ : 'no'}`].join('\n'));
}

function autostart(on) {
  if (process.platform !== 'win32') return console.log('Start with Windows is only available on Windows.');
  if (on) fs.writeFileSync(STARTUP, `@echo off\r\ncall "${writeLauncher()}" --no-open\r\n`);
  else if (fs.existsSync(STARTUP)) fs.unlinkSync(STARTUP);
  console.log(`Start with Windows: ${on ? 'on' : 'off'}`);
}

(async () => {
  if (has('--check')) return check();
  const i = args.indexOf('--autostart');
  if (i >= 0) return autostart(args[i + 1] !== 'off');
  writeLauncher();
  await start();
})();
