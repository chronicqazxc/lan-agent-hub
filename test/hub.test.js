import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';
import { HubClient, requestJoin } from '../src/client.js';
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

test('join requests: ask, owner approves once, code handed over once; denial, caps, disabled', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'adm', inviteOnly: true, advertise: false, joinTtlMs: 600 });
  const url = `http://127.0.0.1:${await hub.start()}`;
  const ask = (agentId) => fetch(url + '/join', { method: 'POST', body: JSON.stringify({ agentId, name: 'Bob <b>' }) });

  // public, no credential; but nothing else is
  const r = await ask('bob'); assert.equal(r.status, 202); const { secret } = await r.json();
  assert.equal((await fetch(`${url}/join/${secret}`).then((x) => x.json())).status, 'pending');
  assert.equal((await fetch(url + '/join/not-a-secret')).status, 404);
  assert.equal((await fetch(url + '/api/joins')).status, 401);

  // owner sees it (id + ip, never the secret) and approves
  const list = await (await call(url, 'adm', 'GET', '/api/joins')).json();
  assert.equal(list.length, 1); assert.equal(list[0].agentId, 'bob'); assert.ok(list[0].ip); assert.ok(!JSON.stringify(list).includes(secret));
  assert.equal((await call(url, 'adm', 'POST', `/api/joins/${list[0].id}/approve`)).status, 200);
  const got = await (await fetch(`${url}/join/${secret}`)).json();
  assert.equal(got.status, 'approved'); assert.match(got.code, /^lah_/);
  assert.equal((await fetch(`${url}/join/${secret}`)).status, 404); // code is handed over once
  const bob = new HubClient({ url, token: got.code, id: 'ignored' }); await bob.connect(); assert.equal(bob.agent.id, 'bob');
  const st = await (await call(url, 'adm', 'GET', '/api/state')).json();
  assert.ok(!JSON.stringify(st).includes(got.code) && st.joins.length === 0);

  // taken ids, denial, duplicate pending
  assert.equal((await ask('bob')).status, 409);
  const s2 = (await (await ask('eve')).json()).secret;
  assert.equal((await ask('eve')).status, 409);
  const eve = (await (await call(url, 'adm', 'GET', '/api/joins')).json())[0];
  await call(url, 'adm', 'POST', `/api/joins/${eve.id}/deny`);
  assert.equal((await fetch(`${url}/join/${s2}`).then((x) => x.json())).status, 'denied');
  assert.equal((await call(url, 'adm', 'POST', `/api/joins/${eve.id}/approve`)).status, 404);

  // per-IP cap (3 pending) and expiry
  for (const n of ['a1', 'a2', 'a3']) assert.equal((await ask(n)).status, 202);
  assert.equal((await ask('a4')).status, 429);
  await wait(800);
  assert.equal((await (await call(url, 'adm', 'GET', '/api/joins')).json()).length, 0); // expired
  assert.equal((await ask('late')).status, 202);

  // client helper
  const p = requestJoin(url, { agentId: 'viaclient', pollMs: 50, timeoutMs: 3000 });
  await wait(200);
  const pending = (await (await call(url, 'adm', 'GET', '/api/joins')).json()).find((j) => j.agentId === 'viaclient');
  await call(url, 'adm', 'POST', `/api/joins/${pending.id}/approve`);
  const res = await p; assert.equal(res.status, 'approved'); assert.equal(res.agentId, 'viaclient');

  bob.close(); await hub.stop();

  // disabled without a token or when switched off
  for (const o of [{ token: null }, { token: 'x', joinRequests: false }]) {
    const h = createHub({ port: 0, host: '127.0.0.1', advertise: false, ...o });
    const u = `http://127.0.0.1:${await h.start()}`;
    assert.equal((await fetch(u + '/join', { method: 'POST', body: '{"agentId":"q"}' })).status, 404); await h.stop();
  }
});

test('mcp bridge pushes incoming messages as claude/channel notifications', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'c', advertise: false });
  const port = await hub.start(); const url = `http://127.0.0.1:${port}`;
  const bridge = spawn(process.execPath, [join(import.meta.dirname, '../bin/lah.js'), 'mcp'],
    { env: { ...process.env, LAH_URL: url, LAH_TOKEN: 'c', LAH_AGENT_ID: 'bridge', CLAUDE_CODE_MESSAGING_SOCKET: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = []; let buf = '';
  bridge.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  await wait(800);
  const init = lines.find((l) => l.id === 1).result;
  assert.deepEqual(init.capabilities.experimental['claude/channel'], {});
  assert.match(init.instructions, /channel/);
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const a = new HubClient({ url, token: 'c', id: 'alice' }); await a.connect();
  await a.send('bridge', 'hello channel'); await wait(300);
  const n = lines.find((l) => l.method === 'notifications/claude/channel');
  assert.equal(n.params.content, 'hello channel');
  assert.equal(n.params.meta.from, 'alice');
  bridge.kill(); a.close(); await hub.stop();
});

test('forget: removes an offline agent (and its invite), refuses online ones', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'adm', advertise: false });
  const port = await hub.start(); const url = `http://127.0.0.1:${port}`;
  const H = { authorization: 'Bearer adm' };
  const a = new HubClient({ url, token: 'adm', id: 'alice' }); await a.connect();
  const b = new HubClient({ url, token: 'adm', id: 'bob' }); await b.connect();
  b.close(); await wait(100);
  await a.send('bob', 'queued');
  assert.equal((await fetch(`${url}/api/agents/alice`, { method: 'DELETE', headers: H })).status, 409); // online
  assert.equal((await fetch(`${url}/api/agents/bob`, { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await fetch(`${url}/api/agents/bob`, { method: 'DELETE', headers: H })).status, 404);
  assert.equal((await fetch(`${url}/api/agents/bob`, { method: 'DELETE' })).status, 401);
  assert.ok(!(await a.list()).some((x) => x.id === 'bob'));
  a.close(); await hub.stop();
});

test('mcp bridge remembers its approved invite and rejoins after a restart with the same id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lah-home-'));
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'adm', advertise: false });
  const port = await hub.start(); const url = `http://127.0.0.1:${port}`;
  const H = { authorization: 'Bearer adm' };
  const run = () => {
    const p = spawn(process.execPath, [join(import.meta.dirname, '../bin/lah.js'), 'mcp'],
      { env: { ...process.env, LAH_HOME: home, LAH_URL: url, LAH_TOKEN: '', LAH_AGENT_ID: 'mac-claude' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = []; let buf = '';
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const rpc = async (id, method, params) => { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 60 && !lines.find((l) => l.id === id); i++) await wait(100); return lines.find((l) => l.id === id)?.result; };
    return { p, rpc };
  };
  const hello = (b) => b.rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const whoami = async (b) => JSON.parse((await b.rpc(9, 'tools/call', { name: 'lan_whoami', arguments: {} }))?.content?.[0]?.text ?? '{}');

  let b = run(); await hello(b);
  await b.rpc(2, 'tools/call', { name: 'lan_request_join', arguments: { url } });
  let req; for (let i = 0; i < 30 && !req; i++) { await wait(100); req = (await (await fetch(`${url}/api/joins`, { headers: H })).json())[0]; }
  assert.equal(req.agentId, 'mac-claude');
  await fetch(`${url}/api/joins/${req.id}/approve`, { method: 'POST', headers: H });
  for (let i = 0; i < 60 && !existsSync(join(home, 'credentials.json')); i++) await wait(100);
  assert.ok(existsSync(join(home, 'credentials.json')), 'credential saved after approval');
  b.p.kill(); await wait(300);

  b = run(); await hello(b); await wait(500); // no join request this time
  assert.equal((await whoami(b)).id, 'mac-claude');
  assert.equal((await (await fetch(`${url}/api/joins`, { headers: H })).json()).length, 0);
  b.p.kill(); await hub.stop();
});

test('mcp bridge pushes incoming messages to the session inbox socket as a user frame', async () => {
  const { createServer } = await import('node:net');
  const sockPath = join(mkdtempSync(join(tmpdir(), 'lah-sock-')), 'in.sock');
  const got = [];
  const sock = createServer((c) => { let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => got.push(...b.split('\n').filter(Boolean).map((l) => JSON.parse(l)))); });
  await new Promise((r) => sock.listen(sockPath, r));
  const hub = createHub({ port: 0, host: '127.0.0.1', token: 'c', advertise: false });
  const port = await hub.start(); const url = `http://127.0.0.1:${port}`;
  const bridge = spawn(process.execPath, [join(import.meta.dirname, '../bin/lah.js'), 'mcp'],
    { env: { ...process.env, LAH_URL: url, LAH_TOKEN: 'c', LAH_AGENT_ID: 'bridge-sock', LAH_HOME: mkdtempSync(join(tmpdir(), 'lah-h-')), CLAUDE_CODE_MESSAGING_SOCKET: sockPath, CLAUDE_CODE_MESSAGING_TOKEN: 'tok123' }, stdio: ['pipe', 'pipe', 'ignore'] });
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  await wait(800);
  const a = new HubClient({ url, token: 'c', id: 'alice' }); await a.connect();
  await a.send('bridge-sock', 'hello socket'); await wait(500);
  assert.deepEqual(got[0], { type: 'auth', token: 'tok123' });
  assert.equal(got[1].type, 'user'); assert.equal(got[1].message.role, 'user');
  assert.match(got[1].message.content, /^\[LAN message from alice /); assert.match(got[1].message.content, /hello socket/);
  bridge.kill(); a.close(); sock.close(); await hub.stop();
});
