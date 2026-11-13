import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';
import { HubClient } from '../src/client.js';

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
