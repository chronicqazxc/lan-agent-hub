import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';
import { HubClient } from '../src/client.js';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('direct, topic, offline queue, HTTP interop, auth', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 's3', advertise: false });
  const port = await hub.start(); const url = `http://127.0.0.1:${port}`;
  const mk = (id) => new HubClient({ url, token: 's3', id });
  const a = mk('alice'), b = mk('bob');
  await a.connect(); await b.connect();

  const ack = await a.send('bob', 'hi');
  assert.deepEqual(ack.delivered, ['bob']); await wait(50);
  assert.equal(b.drain()[0].content.body, 'hi');

  await b.subscribe('news'); const t = await a.send('#news', { x: 1 }); assert.deepEqual(t.delivered, ['bob']);
  await wait(50); assert.deepEqual(b.drain()[0].content.body, { x: 1 });

  b.close(); await wait(50);
  const q = await a.send('bob', 'later'); assert.deepEqual(q.queued, ['bob']);
  const b2 = mk('bob'); await b2.connect(); await wait(50);
  assert.equal(b2.drain()[0].content.body, 'later');

  const r = await fetch(`${url}/messages`, { method: 'POST', headers: { authorization: 'Bearer s3' }, body: JSON.stringify({ from: 'curl-agent', to: 'alice', content: 'from curl' }) });
  assert.equal(r.status, 202); await wait(50);
  assert.equal(a.drain()[0].content.body, 'from curl');

  assert.equal((await fetch(`${url}/agents`)).status, 401);
  a.close(); b2.close(); await hub.stop();
});

test('dashboard: UI page, state with queue + log, SSE stream', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'k', advertise: false });
  const port = await hub.start(); const url = `http://127.0.0.1:${port}`;
  const a = new HubClient({ url, token: 'k', id: 'a' }); await a.connect();
  assert.match(await (await fetch(url + '/')).text(), /LAN Agent Hub/);           // page is public
  assert.equal((await fetch(url + '/api/state')).status, 401);                    // data is not
  await fetch(`${url}/agents`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: JSON.stringify({ id: 'offline-bot' }) });
  await a.send('offline-bot', 'queued msg'); await wait(60);
  const st = await (await fetch(url + '/api/state?token=k')).json();
  assert.equal(st.agents.find((x) => x.id === 'offline-bot').queue[0].preview, 'queued msg');
  assert.equal(st.messages.at(-1).status, 'queued');

  const ctrl = new AbortController();
  const res = await fetch(url + '/api/events?token=k', { signal: ctrl.signal });
  const reader = res.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^data: \{/);
  const next = reader.read(); await a.send('offline-bot', 'again');
  assert.match(new TextDecoder().decode((await next).value), /again/);
  ctrl.abort(); a.close(); await hub.stop();
});

test('client keeps retrying and re-discovers a hub that moved', async () => {
  const hub1 = createHub({ port: 0, host: '127.0.0.1', token: 't', advertise: false });
  const url1 = `http://127.0.0.1:${await hub1.start()}`;
  let moved = null;
  const c = new HubClient({ url: url1, token: 't', id: 'rover', rediscover: async () => moved });
  await c.connect();
  await hub1.stop(); await wait(100); // hub gone: reconnect attempts fail and must keep retrying
  const hub2 = createHub({ port: 0, host: '127.0.0.1', token: 't', advertise: false });
  moved = `http://127.0.0.1:${await hub2.start()}`; // same hub, new address
  const back = new Promise((resolve) => c.once('open', resolve));
  await Promise.race([back, wait(8000).then(() => { throw new Error('did not reconnect'); })]);
  assert.ok((await c.list()).some((a) => a.id === 'rover'));
  c.close(); await hub2.stop();
});

const call = (url, key, method, path, body) => fetch(url + path, { method, headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) });

test('invites: per-agent credentials, invite-only, revoke, kick, persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lah-'));
  const invitesFile = join(dir, 'invites.json');
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'adm', inviteOnly: true, invitesFile, advertise: false });
  const url = `http://127.0.0.1:${await hub.start()}`;

  // invite-only: the admin token cannot join as an agent (WS or HTTP), but manages the hub
  await assert.rejects(new HubClient({ url, token: 'adm', id: 'sneaky' }).connect());
  assert.equal((await call(url, 'adm', 'POST', '/messages', { from: 'x', to: 'y', content: 'hi' })).status, 403);
  assert.equal((await call(url, 'adm', 'GET', '/api/state')).status, 200);

  const mkInvite = async (agentId) => (await (await call(url, 'adm', 'POST', '/api/invites', { agentId })).json()).code;
  const bobCode = await mkInvite('bob'), aliceCode = await mkInvite('alice');
  assert.equal((await call(url, 'adm', 'POST', '/api/invites', { agentId: 'bob' })).status, 409);
  assert.match(bobCode, /^lah_/);

  // the invite fixes identity, whatever id the client asks for
  const bob = new HubClient({ url, token: bobCode, id: 'someone-else' });
  await bob.connect(); assert.equal(bob.agent.id, 'bob');
  const alice = new HubClient({ url, token: aliceCode, id: 'alice' }); await alice.connect();
  assert.deepEqual((await alice.send('bob', 'hello')).delivered, ['bob']); await wait(50);
  const got = bob.drain()[0]; assert.equal(got.from, 'alice'); assert.equal(got.content.body, 'hello');

  // invite holders are not admins and cannot impersonate over HTTP
  assert.equal((await call(url, bobCode, 'GET', '/api/state')).status, 403);
  assert.equal((await call(url, bobCode, 'POST', '/api/invites', { agentId: 'z' })).status, 403);
  assert.equal((await call(url, bobCode, 'GET', '/inbox/alice')).status, 403);
  const spoof = await call(url, bobCode, 'POST', '/messages', { from: 'alice', to: 'alice', content: 'spoof' });
  assert.equal(spoof.status, 202); await wait(50);
  assert.equal(alice.drain().at(-1).from, 'bob'); // "from" was forced to the invite's agent

  // state lists invites without codes
  const st = await (await call(url, 'adm', 'GET', '/api/state')).json();
  assert.deepEqual(st.invites.map((i) => i.agentId).sort(), ['alice', 'bob']);
  assert.ok(!JSON.stringify(st).includes(bobCode) && !readFileSync(invitesFile, 'utf8').includes(bobCode));

  // kick disconnects without revoking; kicked clients do not auto-reconnect
  const denied = new Promise((r) => alice.once('denied', r));
  assert.equal((await (await call(url, 'adm', 'POST', '/api/agents/alice/kick')).json()).wasOnline, true);
  await denied; await wait(2500); assert.equal(hub.agents.get('alice').ws, null);
  const alice2 = new HubClient({ url, token: aliceCode, id: 'alice' }); await alice2.connect(); // still invited

  // revoke: disconnected now, credential dead, agent forgotten
  const bobDenied = new Promise((r) => bob.once('denied', r));
  assert.equal((await call(url, 'adm', 'DELETE', '/api/invites/bob')).status, 200);
  await bobDenied; assert.equal(hub.agents.has('bob'), false);
  await assert.rejects(new HubClient({ url, token: bobCode, id: 'bob' }).connect());

  // invites survive a hub restart
  alice2.close(); await hub.stop();
  const hub2 = createHub({ port: 0, host: '127.0.0.1', token: 'adm', inviteOnly: true, invitesFile, advertise: false });
  const url2 = `http://127.0.0.1:${await hub2.start()}`;
  const again = new HubClient({ url: url2, token: aliceCode, id: 'alice' }); await again.connect();
  again.close(); await hub2.stop();
});

test('open mode: hub token still joins; invites work alongside it', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'adm', advertise: false });
  const url = `http://127.0.0.1:${await hub.start()}`;
  const c = new HubClient({ url, token: 'adm', id: 'shared' }); await c.connect();
  const code = (await (await call(url, 'adm', 'POST', '/api/invites', { agentId: 'inv' })).json()).code;
  const i = new HubClient({ url, token: code, id: 'inv' }); await i.connect();
  assert.deepEqual((await c.send('inv', 'x')).delivered, ['inv']);
  c.close(); i.close(); await hub.stop();
});

test('one hub per PC: a second `lah hub` is refused, stale lock is ignored', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lah-home-'));
  const env = { ...process.env, LAH_HOME: home };
  const run = () => spawn(process.execPath, ['bin/lah.js', 'hub', '--port', '0', '--token', 't', '--advertise', '0'], { env });
  const first = run();
  await new Promise((r) => first.stdout.on('data', (d) => /listening/.test(d) && r()));
  const lock = JSON.parse(readFileSync(join(home, 'hub.lock'), 'utf8')); assert.equal(lock.pid, first.pid);
  const second = run(); let err = ''; second.stderr.on('data', (d) => (err += d));
  assert.equal(await new Promise((r) => second.on('exit', r)), 1); assert.match(err, /one hub per PC/);
  first.kill('SIGTERM'); await new Promise((r) => first.on('exit', r));
  assert.equal(existsSync(join(home, 'hub.lock')), false); // released on exit
  writeFileSync(join(home, 'hub.lock'), JSON.stringify({ pid: 999999, port: 1 })); // stale
  const third = run(); await new Promise((r) => third.stdout.on('data', (d) => /listening/.test(d) && r()));
  third.kill('SIGTERM'); await new Promise((r) => third.on('exit', r));
});
