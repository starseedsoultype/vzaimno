import { createClient } from "jsr:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("VZ_BOT_TOKEN")!;
const WEBAPP_URL = "https://starseedsoultype.github.io/vzaimno/";
// Секрет вебхука выводится из токена: отдельный секрет хранить не нужно.
const SECRET = crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN))
  .then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
const API = `https://api.telegram.org/bot${TOKEN}`;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BUCKET = "vz-shots";
const H = 3600_000;
const DESCRIPTION = `Взаимно помогает авторам и блогерам обмениваться оценками книг и подписками без ручного поиска в чате.

Обмен доступен для книг и профилей ЛитРес, групп в Telegram, ВК, Бусти, TikTok и Instagram.

Карточки авторов собраны в ленте, и ничего не тонет. Каждый обмен подтверждается скрином, второй автор отвечает тем же. Рейтинг взаимности виден всем.

Ссылки проверяются: принимаются только адреса этих площадок, это защищает от мошенничества.

Открывается прямо в Telegram, ничего устанавливать не нужно 📚`;
const ABOUT = "Обмен оценками и подписками для авторов и блогеров. Карточки в ленте, подтверждение скрином, рейтинг взаимности.";

const FIELDS = ["book", "profile", "tg", "vk", "boosty", "tiktok", "insta"] as const;
type Field = typeof FIELDS[number] | "reel";
const LABEL: Record<Field, string> = {
  reel: "поддержка рилса (комментарий, сохранение, пересылка)",
  book: "оценка книге на ЛитРес",
  profile: "подписка на профиль ЛитРес",
  tg: "подписка на ТГ-группу",
  vk: "подписка на ВК",
  boosty: "подписка на Бусти",
  tiktok: "подписка на TikTok",
  insta: "подписка на Instagram",
};
// Только эти адреса, чтобы в карточках не было скама.
// Рилсы: конкретное видео в Instagram, TikTok, ВК Клипах или YouTube Shorts.
const REEL = /^https:\/\/((www\.)?instagram\.com\/(reels?|p)\/[\w-]+|(www\.|vm\.)?tiktok\.com\/(@[\w.]+\/video\/\d+|[\w]+)|(m\.)?vk\.(com|ru)\/clip-?\d+_\d+|(www\.)?youtube\.com\/shorts\/[\w-]+)\/?(\?\S*)?$/;
const REEL_TTL = 48 * H;
const PATTERN: Record<typeof FIELDS[number], RegExp> = {
  book: /^https:\/\/(www\.)?litres\.ru\/(book\/\S+|\d+\/?)$/,
  profile: /^https:\/\/(www\.)?litres\.ru\/author\/[\w-]+\/?$/,
  tg: /^https:\/\/t\.me\/[\w+]+\/?$/,
  vk: /^https:\/\/(m\.)?vk\.(com|ru)\/[\w.]+\/?$/,
  boosty: /^https:\/\/(www\.)?boosty\.to\/[\w.-]+\/?(\?\S*)?$/,
  tiktok: /^https:\/\/(www\.)?tiktok\.com\/@[\w.]+\/?(\?\S*)?$/,
  insta: /^https:\/\/(www\.)?instagram\.com\/[\w.]+\/?(\?\S*)?$/,
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

async function tg(method: string, body: unknown) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
const openBtn = (text = "Открыть Взаимно") => ({ inline_keyboard: [[{ text, web_app: { url: WEBAPP_URL } }]] });
const send = (chat_id: number, text: string) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup: openBtn() });
const h = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function sendPhoto(chat_id: number, bytes: Uint8Array, caption: string) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("caption", caption);
  fd.append("reply_markup", JSON.stringify(openBtn()));
  fd.append("photo", new Blob([bytes], { type: "image/jpeg" }), "shot.jpg");
  await fetch(`${API}/sendPhoto`, { method: "POST", body: fd });
}

// Проверка подписи Telegram: подделать пользователя нельзя.
async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
async function verify(initData: string) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  const sig = [...await hmac(secret, check)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!hash || sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  return { user: JSON.parse(p.get("user") ?? "{}"), start: p.get("start_param") };
}

async function getUser(id: number) {
  const { data } = await db.from("vz_users").select("*").eq("tg_id", id).maybeSingle();
  return data;
}
async function rating(id: number): Promise<number | null> {
  const { data } = await db.rpc("vz_rating", { uid: id });
  return data;
}
const signed = async (path: string) =>
  (await db.storage.from(BUCKET).createSignedUrl(path, 3600)).data?.signedUrl ?? null;

function decodeImage(dataUrl: string) {
  const b64 = dataUrl.split(",")[1] ?? "";
  if (b64.length > 4_000_000) throw new Error("big");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function card(u: any, field: Field, reel?: { id: number; url: string } | null) {
  return {
    tg_id: u.tg_id, name: u.name ?? "Автор", photo: u.photo_custom ?? u.photo_url,
    url: reel ? reel.url : u[field], reel_id: reel?.id ?? null, field, rating: await rating(u.tg_id),
  };
}
async function getReel(id: number | null) {
  if (!id) return null;
  const { data } = await db.from("vz_reels").select("*").eq("id", id).maybeSingle();
  return data;
}
async function activeReels(uid: number) {
  const { data } = await db.from("vz_reels").select("*").eq("user_id", uid).eq("retired", false)
    .gt("created_at", new Date(Date.now() - REEL_TTL).toISOString()).order("created_at", { ascending: false });
  return data ?? [];
}

const actions: Record<string, (me: any, b: any) => Promise<unknown>> = {
  async me(me) {
    const { data: unanswered } = await db.rpc("vz_unanswered", { uid: me.tg_id });
    // Прогресс: сколько получено, сколько сделано сегодня, серия дней подряд.
    const { data: got } = await db.from("vz_tasks").select("field").eq("to_id", me.tg_id).eq("status", "ok");
    const { data: sent } = await db.from("vz_tasks").select("created_at").eq("from_id", me.tg_id).eq("status", "ok")
      .gt("created_at", new Date(Date.now() - 400 * 24 * H).toISOString());
    const day = (d: string | number) => new Date(d).toISOString().slice(0, 10);
    const days = new Set((sent ?? []).map((t) => day(t.created_at)));
    const today = day(Date.now());
    let streak = 0;
    for (let d = days.has(today) ? Date.now() : Date.now() - 24 * H; days.has(day(d)); d -= 24 * H) streak++;
    // Новое с прошлого входа: для всплывашки «+1».
    const since = me.last_seen_at ?? me.created_at;
    const { data: fresh } = await db.from("vz_tasks").select("from_id, field, is_reply")
      .eq("to_id", me.tg_id).eq("status", "ok").gt("created_at", since).order("created_at");
    const events = [];
    for (const t of fresh ?? []) {
      const u = await getUser(t.from_id);
      events.push({ name: u?.name ?? "Автор", field: t.field, is_reply: t.is_reply });
    }
    await db.from("vz_users").update({ last_seen_at: new Date().toISOString() }).eq("tg_id", me.tg_id);
    return {
      user: me, rating: await rating(me.tg_id), unanswered, events,
      stats: {
        stars: (got ?? []).filter((t) => t.field === "book").length,
        subs: (got ?? []).filter((t) => t.field !== "book").length,
        today: (sent ?? []).filter((t) => day(t.created_at) === today).length,
        streak,
      },
    };
  },

  async avatar(me, b) {
    const bytes = decodeImage(String(b.image));
    const path = `${me.tg_id}-${Date.now()}.jpg`;
    await db.storage.from("vz-ava").upload(path, bytes, { contentType: "image/jpeg" });
    const url = db.storage.from("vz-ava").getPublicUrl(path).data.publicUrl;
    await db.from("vz_users").update({ photo_custom: url }).eq("tg_id", me.tg_id);
    return { url };
  },

  async save(me, b) {
    const patch: Record<string, string | null> = {};
    for (const f of FIELDS) {
      const v = String(b[f] ?? "").trim();
      if (v && !PATTERN[f].test(v)) return { error: f };
      patch[f] = v || null;
    }
    await db.from("vz_users").update(patch).eq("tg_id", me.tg_id);
    return { ok: true };
  },

  async reels(me) {
    return { reels: await activeReels(me.tg_id) };
  },

  // Новый рилс; у человека не больше 2 активных, самый старый уходит.
  async reel_add(me, b) {
    const url = String(b.url ?? "").trim();
    if (!REEL.test(url)) return { error: "reel" };
    await db.from("vz_reels").insert({ user_id: me.tg_id, url });
    const old = (await activeReels(me.tg_id)).slice(2).map((r) => r.id);
    if (old.length) await db.from("vz_reels").update({ retired: true }).in("id", old);
    return { reels: await activeReels(me.tg_id) };
  },

  async feed(me, b) {
    if (b.field === "reel") {
      if (!(await activeReels(me.tg_id)).length) return { card: null };
      const { data } = await db.rpc("vz_reel_feed", { me: me.tg_id, lim: 1 });
      const r = data?.[0];
      const owner = r ? await getUser(r.owner) : null;
      return { card: owner ? await card(owner, "reel", { id: r.reel_id, url: r.url }) : null };
    }
    const field = b.field as Field;
    if (!FIELDS.includes(field as any) || !me[field]) return { card: null };
    const { data } = await db.rpc("vz_feed", { me: me.tg_id, f: field, lim: 1 });
    return { card: data?.[0] ? await card(data[0], field) : null };
  },

  async skip(me, b) {
    await db.from("vz_skips").upsert({
      user_id: me.tg_id, target_id: b.to_id, field: b.field, skipped_at: new Date().toISOString(), done: !!b.done,
    });
    return { ok: true };
  },

  // Скрин: задание по карточке из ленты (reply = false) или ответ взаимностью (reply = true).
  async shot(me, b) {
    const field = b.field as Field;
    const to = await getUser(Number(b.to_id));
    const reply = !!b.reply;
    let reel_id: number | null = null, back_reel_id: number | null = null;
    if (field === "reel") {
      const reel = await getReel(Number(b.reel_id));
      if (!to || !reel || reel.user_id !== to.tg_id) return { error: "field" };
      reel_id = reel.id;
      // Мой свежий рилс: им мне ответят взаимностью.
      if (!reply) back_reel_id = (await activeReels(me.tg_id))[0]?.id ?? null;
      if (!reply && !back_reel_id) return { error: "noreel" };
    } else if (!FIELDS.includes(field as any) || !to || !to[field] || !me[field]) return { error: "field" };
    const bytes = decodeImage(String(b.image));
    const path = `${me.tg_id}/${field}-${to.tg_id}-${reply ? "r" : "o"}-${Date.now()}.jpg`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg" });
    const now = new Date().toISOString();
    // Первый обмен приглашённого: триггер в базе поднимает пригласившего на сутки.
    const bonusFor = me.invited_by && !me.ref_bonus_given ? me.invited_by : null;
    await db.from("vz_tasks").upsert({
      field, from_id: me.tg_id, to_id: to.tg_id, is_reply: reply, shot_path: path, status: "ok",
      created_at: now, answered_at: null, reminded_at: null, notified_at: null, reel_id, back_reel_id,
    }, { onConflict: "field,from_id,to_id,is_reply,reel_id" });
    if (reply) {
      let q = db.from("vz_tasks").update({ answered_at: now })
        .eq("field", field).eq("from_id", to.tg_id).eq("to_id", me.tg_id).eq("is_reply", false);
      if (field === "reel") q = q.eq("back_reel_id", reel_id);
      await q;
    }
    const name = me.name ?? "Автор";
    const caption = reply
      ? `${name} ответил(а) вам взаимностью: ${LABEL[field]}.`
      : `${name} выполнил(а) задание: ${LABEL[field]}. Ответьте взаимностью во «Взаимно».`;
    await sendPhoto(to.tg_id, bytes, caption);
    if (bonusFor) {
      await send(bonusFor, `<b>🎉 ${h(name)} по вашему приглашению сделал(а) первый обмен. Ваша карточка сутки показывается всем наверху.</b>`);
    }
    return { ok: true };
  },

  async reject(me, b) {
    const { data: t } = await db.from("vz_tasks").select("*")
      .eq("id", b.task_id).eq("to_id", me.tg_id).eq("status", "ok").maybeSingle();
    if (!t) return { error: "task" };
    await db.from("vz_tasks").update({ status: "rejected" }).eq("id", t.id);
    if (t.is_reply) {
      let q = db.from("vz_tasks").update({ answered_at: null })
        .eq("field", t.field).eq("from_id", me.tg_id).eq("to_id", t.from_id).eq("is_reply", false);
      if (t.field === "reel") q = q.eq("back_reel_id", t.reel_id);
      await q;
    }
    await send(t.from_id, `${h(me.name ?? "Автор")} не принял(а) ваш скрин: ${LABEL[t.field as Field]}. Пришлите скрин заново.`);
    return { ok: true };
  },

  // Жалоба на карточку (to_id) или на присланный мне скрин (task_id).
  async report(me, b) {
    const reason = ["scam", "fake", "nsfw", "other"].includes(b.reason) ? b.reason : "other";
    let to = Number(b.to_id);
    let task_id: number | null = null;
    if (b.task_id) {
      const { data: t } = await db.from("vz_tasks").select("id, from_id").eq("id", b.task_id).eq("to_id", me.tg_id).maybeSingle();
      if (!t) return { error: "task" };
      to = t.from_id; task_id = t.id;
    }
    if (!to || to === me.tg_id) return { error: "self" };
    const { data: dup } = await db.from("vz_reports").select("id").eq("from_id", me.tg_id).eq("to_id", to)
      .filter("task_id", task_id ? "eq" : "is", task_id ?? null).maybeSingle();
    if (!dup) await db.from("vz_reports").insert({ from_id: me.tg_id, to_id: to, reason, task_id });
    return { ok: true };
  },

  async admin_list(me) {
    if (!me.is_admin) return { error: "admin" };
    const { data: users } = await db.from("vz_users").select("*").order("created_at", { ascending: false });
    const { data: reports } = await db.from("vz_reports").select("to_id, reason, task_id, created_at");
    const { data: shots } = await db.from("vz_tasks").select("id, shot_path")
      .in("id", (reports ?? []).map((r) => r.task_id).filter(Boolean));
    const { data: rejected } = await db.from("vz_tasks").select("from_id").eq("status", "rejected");
    const list = [];
    for (const u of users ?? []) {
      const rs = [];
      for (const r of (reports ?? []).filter((r) => r.to_id === u.tg_id)) {
        const path = (shots ?? []).find((t) => t.id === r.task_id)?.shot_path;
        rs.push({ reason: r.reason, at: r.created_at, shot: path ? await signed(path) : null });
      }
      list.push({
        tg_id: u.tg_id, name: u.name, photo: u.photo_custom ?? u.photo_url,
        rating: await rating(u.tg_id), banned: u.banned, hidden: u.hidden, pinned: u.is_pinned,
        rejected: (rejected ?? []).filter((t) => t.from_id === u.tg_id).length, reports: rs,
        links: FIELDS.map((f) => u[f]).filter(Boolean),
      });
    }
    return { users: list };
  },

  async admin_set(me, b) {
    if (!me.is_admin) return { error: "admin" };
    const patch: Record<string, boolean> = {};
    if (typeof b.banned === "boolean") patch.banned = b.banned;
    if (typeof b.hidden === "boolean") patch.hidden = b.hidden;
    if (typeof b.pinned === "boolean") patch.is_pinned = b.pinned;
    await db.from("vz_users").update(patch).eq("tg_id", b.tg_id);
    // Вернули карточку после жалоб: счётчик жалоб обнуляется.
    if (b.hidden === false) await db.from("vz_reports").delete().eq("to_id", b.tg_id);
    return { ok: true };
  },

  async inbox(me) {
    const week = new Date(Date.now() - 7 * 24 * H).toISOString();
    const { data: incoming } = await db.from("vz_tasks").select("*")
      .eq("to_id", me.tg_id).eq("status", "ok").gt("created_at", week).order("created_at", { ascending: false });
    const { data: rejected } = await db.from("vz_tasks").select("*")
      .eq("from_id", me.tg_id).eq("status", "rejected").order("created_at", { ascending: false });
    const items = [];
    for (const t of [...(incoming ?? []), ...(rejected ?? [])]) {
      const mine = t.from_id === me.tg_id;
      const other = await getUser(mine ? t.to_id : t.from_id);
      if (!other) continue;
      const kind = mine ? "resend" : !t.is_reply && !t.answered_at ? "reply" : "received";
      // Для рилса: отвечаем на рилс отправителя, повторяем на тот же рилс.
      const reel = t.field === "reel" ? await getReel(kind === "reply" ? t.back_reel_id : t.reel_id) : null;
      if (t.field === "reel" && !reel) continue;
      items.push({
        id: t.id,
        kind,
        is_reply: t.is_reply,
        card: await card(other, t.field, reel),
        shot: mine ? null : await signed(t.shot_path),
      });
    }
    return { items };
  },
};

async function onBotUpdate(update: any) {
  const msg = update.message;
  if (!msg || msg.chat?.type !== "private") return;
  const ref = /^\/start ref_(\d+)$/.exec(msg.text ?? "")?.[1];
  const url = ref ? `${WEBAPP_URL}?ref=${ref}` : WEBAPP_URL;
  await tg("sendMessage", {
    chat_id: msg.chat.id,
    text: "Взаимно: обмен оценками и подписками между авторами. Каждый обмен подтверждается скрином.",
    reply_markup: { inline_keyboard: [[{ text: "Открыть Взаимно", web_app: { url } }]] },
  });
}

// Раз в час: напоминание через 24 часа, сообщение отправителю через 48 часов.
async function cron() {
  const now = Date.now();
  const base = () => db.from("vz_tasks").select("*").eq("is_reply", false).eq("status", "ok").is("answered_at", null);
  const { data: remind } = await base().is("reminded_at", null)
    .lt("created_at", new Date(now - 24 * H).toISOString()).limit(100);
  for (const t of remind ?? []) {
    const from = await getUser(t.from_id);
    await send(t.to_id, `Напоминание: ${h(from?.name ?? "автор")} ждёт ответа взаимностью (${LABEL[t.field as Field]}).`);
    await db.from("vz_tasks").update({ reminded_at: new Date().toISOString() }).eq("id", t.id);
  }
  const { data: notify } = await base().is("notified_at", null)
    .lt("created_at", new Date(now - 48 * H).toISOString()).limit(100);
  for (const t of notify ?? []) {
    const to = await getUser(t.to_id);
    await send(t.from_id, `${h(to?.name ?? "Автор")} пока не ответил(а) вам взаимностью (${LABEL[t.field as Field]}).`);
    await db.from("vz_tasks").update({ notified_at: new Date().toISOString() }).eq("id", t.id);
  }
}

// Раз в день админам: сколько новых пользователей за сутки.
async function daily() {
  const since = new Date(Date.now() - 24 * H).toISOString();
  const { count: fresh } = await db.from("vz_users").select("tg_id", { count: "exact", head: true }).gt("created_at", since);
  const { count: total } = await db.from("vz_users").select("tg_id", { count: "exact", head: true });
  const { data: admins } = await db.from("vz_users").select("tg_id").eq("is_admin", true);
  for (const a of admins ?? []) {
    await send(a.tg_id, `<b>За сутки новых пользователей: ${fresh ?? 0}</b>\nВсего в боте: ${total ?? 0}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);

  // cron и setup безопасно вызывать повторно: они ничего не раскрывают.
  if (url.searchParams.has("cron")) { await cron(); return new Response("ok"); }
  if (url.searchParams.has("daily")) { await daily(); return new Response("ok"); }
  if (url.searchParams.has("setup")) {
    const hook = await tg("setWebhook", {
      url: `https://${url.host}/functions/v1/vzaimno`, secret_token: await SECRET, allowed_updates: ["message"],
    });
    await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Взаимно", web_app: { url: WEBAPP_URL } } });
    // Тексты до нажатия Start: написал Content Creator, проверил Brand Guardian, утвердила Олеся.
    const desc = await tg("setMyDescription", { description: DESCRIPTION });
    const about = await tg("setMyShortDescription", { short_description: ABOUT });
    return json({ hook, desc, about });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") === await SECRET) {
    await onBotUpdate(await req.json()).catch(console.error);
    return new Response("ok");
  }

  const b = await req.json().catch(() => ({}));
  const auth = await verify(String(b.initData ?? ""));
  if (!auth?.user?.id) return json({ error: "auth" }, 401);
  let me = await getUser(auth.user.id);
  if (!me) {
    const refRaw = (auth.start ?? b.ref ?? "").toString().replace(/^ref_/, "");
    const ref = /^\d+$/.test(refRaw) && Number(refRaw) !== auth.user.id ? Number(refRaw) : null;
    await db.from("vz_users").insert({ tg_id: auth.user.id, invited_by: ref });
  }
  // Имя и фото берём из Telegram при каждом входе, чтобы они были свежими.
  await db.from("vz_users").update({ name: auth.user.first_name ?? null, photo_url: auth.user.photo_url ?? null })
    .eq("tg_id", auth.user.id);
  me = await getUser(auth.user.id);
  if (me.banned) return json({ error: "banned" }, 403);
  const fn = actions[b.action];
  if (!fn) return json({ error: "action" }, 400);
  try {
    return json(await fn(me, b));
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
