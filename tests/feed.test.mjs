import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../', import.meta.url);
const backend = readFileSync(new URL('supabase/functions/vzaimno/index.ts', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');
const user = { tg_id: 1, name: 'New' };
const authors = [{ tg_id: 2, name: 'Author', tg: 'https://t.me/example' }, { tg_id: 3, name: 'Reel author' }];
const reels = [];
let targetAvailable = true;
function rowsQuery(getRows) {
  const predicates = [];
  let limit = Infinity;
  const q = {
    select() { return q; },
    eq(k, v) { predicates.push(r => r[k] === v); return q; },
    gt(k, v) { predicates.push(r => r[k] > v); return q; },
    order() { return q; },
    limit(n) { limit = n; return q; },
    async maybeSingle() { return { data: getRows().find(r => predicates.every(p => p(r))) ?? null }; },
    then(resolve, reject) { return Promise.resolve({ data: getRows().filter(r => predicates.every(p => p(r))).slice(0, limit), error: null }).then(resolve, reject); },
  };
  return q;
}
const db = {
  from: name => rowsQuery(() => name === 'vz_users' ? authors : reels),
  rpc(name, args) {
    if (name === 'vz_rating') return Promise.resolve({ data: null });
    return rowsQuery(() => name === 'vz_reel_feed'
      ? [{ reel_id: 100, owner: 3, url: 'https://www.instagram.com/reel/test/' }]
      : args.f === 'tg' && targetAvailable ? [authors[0]] : []);
  },
};
const context = vm.createContext({ createClient: () => db, Deno: { env: { get: () => 'test' }, serve() {} }, crypto: webcrypto, TextEncoder, Uint8Array, URLSearchParams, Response });
vm.runInContext(stripTypeScriptTypes(backend.replace(/^import .*;\n/, '')) + '\nglobalThis.testActions = actions;', context);
let options = await context.testActions.feed_options(user);
assert.equal(options.cards.length, 2);
assert.ok(options.cards.every(c => c.can_exchange === false));
assert.equal((await context.testActions.feed(user, { field: 'invalid' })).card, null);
assert.equal((await context.testActions.feed(user, { field: 'tg', to_id: 999 })).card, null);
user.tg = 'https://t.me/mine';
let selected = await context.testActions.feed(user, { field: 'tg', to_id: 2 });
assert.equal(selected.card.tg_id, 2);
assert.equal(selected.card.can_exchange, true);
targetAvailable = false;
assert.equal((await context.testActions.feed(user, { field: 'tg', to_id: 2 })).card, null);
targetAvailable = true;
selected = await context.testActions.feed(user, { field: 'reel', to_id: 3, reel_id: 100 });
assert.equal(selected.card.can_exchange, false);
reels.push({ user_id: 1, retired: false, created_at: new Date().toISOString() });
assert.equal((await context.testActions.feed(user, { field: 'reel', to_id: 3, reel_id: 100 })).card.can_exchange, true);
reels[0].created_at = new Date(Date.now() - 72 * 3600000).toISOString();
assert.equal((await context.testActions.feed(user, { field: 'reel', to_id: 3, reel_id: 100 })).card.can_exchange, false);
assert.equal((await context.testActions.feed(user, { field: 'reel', to_id: 3, reel_id: 200 })).card, null);

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '', disabled: false, focus() {} });
  return elements.get(id);
};
const app = element('app');
const state = { tab: 'feed', me: { user: { tg_id: 1 }, stats: { given: 0 } }, reels: [] };
const sample = { field: 'tg', tg_id: 2, name: 'Author', can_exchange: false };
let apiResult = { cards: [sample] };
let calls = [];
const front = vm.createContext({
  state, $app: app, document: { getElementById: element, querySelectorAll: () => [] },
  t: ru => ru, esc: String, INFO: { tg: { name: 'Telegram', hint: 'https://t.me/...' }, reel: { name: 'Рилс' } },
  FIELDS: { tg: {}, book: {} }, PATTERN: { tg: /^https:\/\/t\.me\/\w+$/ }, REEL: /^https:\/\/.*reel/,
  hasAny: () => !!state.me.user.tg, progressHtml: () => '', cardHtml: () => '<b>Card</b>',
  api: async (name, body) => { calls.push({ name, body }); return name === 'save' ? { ok: true } : name === 'feed' ? { card: apiResult.cards[0] ?? null } : apiResult; },
  tg: { showAlert(message) { throw new Error(message); }, HapticFeedback: { notificationOccurred() {} } },
  sessionStorage: { setItem() {}, removeItem() {} },
  goTab: tab => { state.tab = tab; state.upload = null; },
});
vm.runInContext(html.slice(html.indexOf('function beginExchange('), html.indexOf('// ---------- Входящие')), front);
await vm.runInContext('renderFeed()', front);
assert.equal(state.upload, null);
assert.ok(element('slot').innerHTML.includes('begin-exchange'));
assert.ok(!element('slot').innerHTML.includes('data-act="shot"'));
front.example = sample;
vm.runInContext('beginExchange(example); renderExchangeSetup()', front);
assert.equal(state.tab, 'profile');
assert.ok(app.innerHTML.includes('Сохранить и вернуться к заданию'));
assert.ok(!app.innerHTML.includes('name="book"'));
element('exchange-url').value = 'https://t.me/mine';
await element('exchange-setup').onsubmit({ preventDefault() {} });
assert.equal(state.tab, 'feed');
assert.equal(state.pendingCard, null);
assert.equal(state.resumeCard.tg_id, 2);
assert.equal(state.me.user.tg, 'https://t.me/mine');
assert.equal(calls.find(c => c.name === 'save').body.book, '');
apiResult = { cards: [{ ...sample, can_exchange: true }] };
await vm.runInContext('renderFeed()', front);
assert.equal(calls.findLast(c => c.name === 'feed').body.to_id, 2);
assert.equal(state.upload.to_id, 2);
assert.ok(element('slot').innerHTML.includes('data-act="shot"'));
// Исчезнувшая карточка не подменяется молча.
state.resumeCard = { field: 'tg', tg_id: 999 };
front.api = async name => name === 'feed' ? { card: null } : apiResult;
await vm.runInContext('renderFeed()', front);
assert.ok(app.innerHTML.includes('Выбранное задание уже недоступно'));
// При отсутствии своей площадки показываются другие доступные задания.
state.field = 'book';
await vm.runInContext('renderFeed()', front);
assert.ok(app.innerHTML.includes('На выбранной площадке новых заданий нет'));
assert.ok(state.card);
// Поздний ответ сети не должен заменить профиль или входящие.
let finish;
front.api = () => new Promise(resolve => { finish = resolve; });
const pending = vm.runInContext('renderFeed()', front);
state.tab = 'inbox'; app.innerHTML = 'inbox';
finish(apiResult); await pending;
assert.equal(app.innerHTML, 'inbox');
console.log('Feed previews, eligibility, selected card return, expiry, fallback, focused setup and navigation races passed.');
