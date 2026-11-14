// One hub per PC: a lock file records the running hub's pid and port.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';

/** Per-user state dir (lock file, invites). Override with LAH_HOME. */
export const homeDir = (env = process.env) => env.LAH_HOME ?? join(homedir(), '.lan-agent-hub');
const lockPath = (env) => join(homeDir(env), 'hub.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The hub already running on this PC ({pid, port}), or null. Stale locks (dead pid) are ignored. */
export function runningHub(env = process.env) {
  try {
    const l = JSON.parse(readFileSync(lockPath(env), 'utf8'));
    return alive(l.pid) ? l : null;
  } catch { return null; }
}

export function writeHubLock(port, env = process.env) {
  mkdirSync(homeDir(env), { recursive: true });
  writeFileSync(lockPath(env), JSON.stringify({ pid: process.pid, port }));
  const release = () => { try { if (JSON.parse(readFileSync(lockPath(env), 'utf8')).pid === process.pid) rmSync(lockPath(env)); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0); });
}

// ---- Client side: stable identity per PC and remembered invite codes, so a restart rejoins without re-approval.
const credPath = (env) => join(homeDir(env), 'credentials.json');
const readCreds = (env) => { try { return JSON.parse(readFileSync(credPath(env), 'utf8')); } catch { return {}; } };

/** Invite code saved for a hub (key = hub name, or its URL), or null. */
export const savedCredential = (key, env = process.env) => (key && readCreds(env)[key]) || null;

export function saveCredential(key, cred, env = process.env) {
  mkdirSync(homeDir(env), { recursive: true });
  writeFileSync(credPath(env), JSON.stringify({ ...readCreds(env), [key]: cred }, null, 2), { mode: 0o600 });
  try { chmodSync(credPath(env), 0o600); } catch {}
}

export function forgetCredential(key, env = process.env) {
  const c = readCreds(env); if (!(key in c)) return;
  delete c[key]; writeFileSync(credPath(env), JSON.stringify(c, null, 2), { mode: 0o600 });
}

/**
 * Claim `agentId` for this process (one live session per id per PC; two would kick each other off the hub).
 * Returns true if claimed. Stale claims (dead pid) are taken over; released on exit.
 */
export function claimAgentId(agentId, env = process.env) {
  const f = join(homeDir(env), `session-${agentId}.lock`);
  try {
    const pid = Number(readFileSync(f, 'utf8'));
    if (pid !== process.pid && alive(pid)) return false;
  } catch {}
  mkdirSync(homeDir(env), { recursive: true });
  writeFileSync(f, String(process.pid));
  process.on('exit', () => { try { if (Number(readFileSync(f, 'utf8')) === process.pid) rmSync(f); } catch {} });
  return true;
}
