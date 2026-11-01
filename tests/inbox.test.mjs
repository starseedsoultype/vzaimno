import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../', import.meta.url);
const backend = readFileSync(new URL('supabase/functions/vzaimno/index.ts', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');
const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const task = (id, extra = {}) => ({ id, from_id: 2, to_id: 1, field: 'tg', status: 'ok', is_reply: false, answered_at: null, created_at: ago(20), shot_path: 'test.jpg', ...extra });
const tables = {
  vz_users: [{ tg_id: 1, tg: 'https://t.me/one' }, { tg_id: 2, name: 'Other', tg: 'https://t.me/two' }],
  vz_tasks: [
    task(1),
    task(2, { field: 'reel', reel_id: 200, back_reel_id: 100, created_at: ago(4) }),
    task(3, { answered_at: ago(19) }),
    task(4, { answered_at: ago(1), created_at: ago(2) }),
    task(5, { is_reply: true, created_at: ago(1) }),
    task(6, { from_id: 1, to_id: 2, status: 'rejected' }),
    task(7, { to_id: 3 }),
    task(8, { created_at: ago(1) }),
  ],
  vz_reels: [{ id: 100, user_id: 2, url: 'https://www.instagram.com/reel/test/', created_at: ago(10), retired: true }],
};
let failQuery = false;
let activeReelLookups = 0;
let sent = 0;
const db = {
  from(name) {
    const predicates = [];
    let order;
    let patch;
    const q = {
      select() { return q; },
      eq(k, v) { predicates.push(r => r[k] === v); return q; },
      is(k, v) { predicates.push(r => r[k] === v); return q; },
      gt(k, v) { if (name === 'vz_reels') activeReelLookups++; predicates.push(r => r[k] > v); return q; },
      or(expression) { assert.equal(expression, 'is_reply.eq.true,answered_at.not.is.null'); predicates.push(r => r.is_reply || r.answered_at !== null); return q; },
      order(k, { ascending }) { order = [k, ascending]; return q; },
      update(value) { patch = value; return q; },
      async upsert(value) { tables[name].push({ id: 99, ...value }); return { error: null }; },
      async maybeSingle() { return { data: tables[name].find(r => predicates.every(f => f(r))) ?? null }; },
      then(resolve, reject) {
        const rows = tables[name].filter(r => predicates.every(f => f(r)));
        if (patch) rows.forEach(r => Object.assign(r, patch));
        if (order) rows.sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : 1) * (order[1] ? 1 : -1));
        return Promise.resolve({ data: rows, error: failQuery ? new Error('database unavailable') : null }).then(resolve, reject);
      },
    };
    return q;
  },
  rpc: async () => ({ data: null }),
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://example.com/test.jpg' } }), upload: async () => ({ error: null }) }) },
};
const context = vm.createContext({
  createClient: () => db,
  Deno: { env: { get: () => 'test' }, serve() {} },
  crypto: webcrypto, TextEncoder, Uint8Array, URL, URLSearchParams, Response,
  FormData, Blob, atob, console,
  fetch: async () => { sent++; return { json: async () => ({ ok: true }) }; },
});
vm.runInContext(stripTypeScriptTypes(backend.replace(/^import .*;\n/, '')) + '\nglobalThis.testActions = actions;', context);
const result = await context.testActions.inbox(tables.vz_users[0]);
assert.deepEqual(Array.from(result.items, i => i.id), [1, 2, 8, 6, 5, 4]);
assert.equal(new Set(result.items.map(i => i.id)).size, result.items.length);
assert.equal(result.items.find(i => i.id === 2).card.reel_id, 100);
assert.equal(result.items.find(i => i.id === 2).kind, 'reply');
assert.equal(result.items.find(i => i.id === 6).kind, 'resend');
failQuery = true;
await assert.rejects(() => context.testActions.inbox(tables.vz_users[0]), /database unavailable/);
failQuery = false;
const reply = await context.testActions.shot(tables.vz_users[0], {
  field: 'reel', to_id: 2, reply: true, reel_id: 100, image: 'data:image/jpeg;base64,YQ==',
});
assert.equal(reply.ok, true);
assert.equal(activeReelLookups, 0);
assert.ok(tables.vz_tasks.find(t => t.id === 2).answered_at);
assert.equal(sent, 1);

// Проверяем разделение карточек и обработку ошибки на клиенте.
const app = { innerHTML: '' };
const state = { tab: 'inbox', upload: { stale: true }, me: { stats: { given: 3 } } };
const front = vm.createContext({
  state, $app: app, api: async () => result,
  t: ru => ru, INFO: { tg: { task: 'Подпишитесь' }, reel: { task: 'Поддержите рилс' } },
  cardHtml: c => `<b>${c.tg_id}</b>`, esc: String,
});
vm.runInContext(html.slice(html.indexOf('async function renderInbox()'), html.indexOf('// ---------- Профиль')), front);
await vm.runInContext('renderInbox()', front);
assert.equal(state.upload, null);
assert.ok(app.innerHTML.includes('Ждут вашего ответа (3)'));
assert.ok(app.innerHTML.includes('Нужно прислать скрин заново (1)'));
assert.ok(app.innerHTML.includes('Завершённые за последние 7 дней (2)'));
assert.equal((app.innerHTML.match(/data-reply=/g) ?? []).length, 3);
assert.equal((app.innerHTML.match(/data-resend=/g) ?? []).length, 1);
front.api = async () => { throw new Error('offline'); };
await vm.runInContext('renderInbox()', front);
assert.ok(app.innerHTML.includes('Не удалось загрузить задания'));
assert.ok(app.innerHTML.includes('Повторить'));
assert.equal(Object.keys(state.items).length, 0);
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log('Old pending tasks, history separation, rejected screenshots, expired reel replies and client errors passed.');
