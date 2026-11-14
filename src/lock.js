// One hub per PC: a lock file records the running hub's pid and port.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

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
