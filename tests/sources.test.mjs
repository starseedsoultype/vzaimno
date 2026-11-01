import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createHmac, webcrypto } from 'node:crypto';

const root = new URL('../', import.meta.url);
const backend = readFileSync(new URL('supabase/functions/vzaimno/index.ts', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const users = new Map();
let handler;
const messages = [];
let rpcCalls = 0;
const db = {
  from(table) {
    let id;
    let patch;
    let mode;
    const q = {
      select() { return q; },
      eq(key, value) { if (key === 'tg_id') id = value; return q; },
      gt() { return q; },
      order() { return q; },
      update(value) { patch = value; mode = 'update'; return q; },
      async maybeSingle() { return { data: users.get(id) ?? null }; },
      async upsert(value, options) {
        assert.equal(table, 'vz_users');
        assert.equal(options.ignoreDuplicates, true);
        if (!users.has(value.tg_id)) users.set(value.tg_id, { ...value });
        return { error: null };
      },
      then(resolve, reject) {
        if (mode === 'update' && users.has(id)) Object.assign(users.get(id), patch);
        return Promise.resolve({ data: [] }).then(resolve, reject);
      },
    };
    return q;
  },
  async rpc() { rpcCalls++; return { data: [], error: null }; },
};
const context = vm.createContext({
  createClient: () => db,
  Deno: { env: { get: () => 'test_token' }, serve: (fn) => { handler = fn; } },
  crypto: webcrypto, TextEncoder, Uint8Array, URL, URLSearchParams, Request, Response,
  console, Date, Map, Set,
  fetch: async (url, options) => {
    assert.ok(url.startsWith('https://api.telegram.org/bottest_token/'));
    messages.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true }) };
  },
});
vm.runInContext(stripTypeScriptTypes(backend.replace(/^import .*;\n/, '')), context);

function signed(id, start) {
  const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Test' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  if (start !== undefined) p.set('start_param', start);
  const check = [...p].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('test_token').digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
async function request(id, start, extra = {}) {
  const response = await handler(new Request('https://example.com/', {
    method: 'POST', body: JSON.stringify({ action: 'reels', initData: signed(id, start), ...extra }),
  }));
  assert.equal(response.status, 200);
  return response.json();
}
await request(1, 'src_Podruga');
assert.equal(users.get(1).source_code, 'podruga');
assert.equal(users.get(1).invited_by, null);
await request(1, 'src_other');
assert.equal(users.get(1).source_code, 'podruga');
await request(2, 'ref_1');
assert.equal(users.get(2).invited_by, 1);
assert.equal(users.get(2).source_code, null);
await request(3, 'ref_3');
assert.equal(users.get(3).invited_by, null);
await request(4, undefined, { source: 'src_from_bot' });
assert.equal(users.get(4).source_code, 'from_bot');
await request(5, 'src_signed', { source: 'src_other' });
assert.equal(users.get(5).source_code, 'signed');
for (const [i, code] of ['', 'src_', 'src_<script>', 'src_a b', 'src_кириллица', 'src_' + 'a'.repeat(61)].entries()) {
  await request(20 + i, code);
  assert.equal(users.get(20 + i).source_code, null);
}
await request(40, 'src_' + 'a'.repeat(60));
assert.equal(users.get(40).source_code.length, 60);
users.set(50, { tg_id: 50, invited_by: 1 });
await request(50, 'src_new');
assert.equal(users.get(50).source_code, undefined);
assert.equal(users.get(50).invited_by, 1);
await Promise.all([request(60, 'src_first'), request(60, 'src_second')]);
assert.equal(users.get(60).source_code, 'first');
assert.equal((await request(1, undefined, { action: 'admin_sources' })).error, 'admin');
assert.equal(rpcCalls, 0);
users.get(1).is_admin = true;
assert.deepEqual(await request(1, undefined, { action: 'admin_sources' }), { sources: [] });
assert.equal(rpcCalls, 1);
const denied = await handler(new Request('https://example.com/', {
  method: 'POST', body: JSON.stringify({ action: 'admin_sources', initData: 'fake', source: 'src_fake' }),
}));
assert.equal(denied.status, 401);
await vm.runInContext('onBotUpdate({message:{chat:{id:1,type:"private"},text:"/start src_Podruga"}})', context);
assert.equal(messages.at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://starseedsoultype.github.io/vzaimno/?source=src_podruga');
await vm.runInContext('onBotUpdate({message:{chat:{id:1,type:"private"},text:"/start ref_2"}})', context);
assert.equal(messages.at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://starseedsoultype.github.io/vzaimno/?ref=2');
console.log('Source attribution, referrals, concurrency, auth, bot links and frontend syntax passed.');
