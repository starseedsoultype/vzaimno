import { createClient } from "jsr:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("VZ_BOT_TOKEN")!;
const SECRET = Deno.env.get("VZ_WEBHOOK_SECRET")!;
const WEBAPP_URL = Deno.env.get("VZ_WEBAPP_URL")!;
const API = `https://api.telegram.org/bot${TOKEN}`;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BUCKET = "vz-shots";
const H = 3600_000;

const FIELDS = ["book", "profile", "tg", "vk", "boosty"] as const;
type Field = typeof FIELDS[number];
const LABEL: Record<Field, string> = {
  book: "оценка книге на ЛитРес",
  profile: "подписка на профиль ЛитРес",
  tg: "подписка на ТГ-группу",
  vk: "подписка на ВК",
  boosty: "подписка на Бусти",
};
// Только эти адреса, чтобы в карточках не было скама.
const PATTERN: Record<Field, RegExp> = {
  book: /^https:\/\/(www\.)?litres\.ru\/(book\/\S+|\d+\/?)$/,
  profile: /^https:\/\/(www\.)?litres\.ru\/author\/[\w-]+\/?$/,
  tg: /^https:\/\/t\.me\/[\w+]+\/?$/,
  vk: /^https:\/\/(m\.)?vk\.(com|ru)\/[\w.]+\/?$/,
  boosty: /^https:\/\/(www\.)?boosty\.to\/[\w.-]+\/?(\?\S*)?$/,
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
const send = (chat_id: number, text: string) => tg("sendMessage", { chat_id, text, reply_markup: openBtn() });

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

async function card(u: any, field: Field) {
  return { tg_id: u.tg_id, name: u.name ?? "Автор", photo: u.photo_url, url: u[field], field, rating: await rating(u.tg_id) };
}

const actions: Record<string, (me: any, b: any) => Promise<unknown>> = {
  async me(me) {
    const { data: unanswered } = await db.rpc("vz_unanswered", { uid: me.tg_id });
    return { user: me, rating: await rating(me.tg_id), unanswered };
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

  async feed(me, b) {
    const field = b.field as Field;
    if (!FIELDS.includes(field) || !me[field]) return { card: null };
    const { data } = await db.rpc("vz_feed", { me: me.tg_id, f: field, lim: 1 });
    return { card: data?.[0] ? await card(data[0], field) : null };
  },

  async skip(me, b) {
    await db.from("vz_skips").upsert({
      user_id: me.tg_id, target_id: b.to_id, field: b.field, skipped_at: new Date().toISOString(),
    });
    return { ok: true };
  },

  // Скрин: задание по карточке из ленты (reply = false) или ответ взаимностью (reply = true).
  async shot(me, b) {
    const field = b.field as Field;
    const to = await getUser(Number(b.to_id));
    if (!FIELDS.includes(field) || !to || !to[field] || !me[field]) return { error: "field" };
    const reply = !!b.reply;
    const bytes = decodeImage(String(b.image));
    const path = `${me.tg_id}/${field}-${to.tg_id}-${reply ? "r" : "o"}-${Date.now()}.jpg`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg" });
    const now = new Date().toISOString();
    await db.from("vz_tasks").upsert({
      field, from_id: me.tg_id, to_id: to.tg_id, is_reply: reply, shot_path: path, status: "ok",
      created_at: now, answered_at: null, reminded_at: null, notified_at: null,
    }, { onConflict: "field,from_id,to_id,is_reply" });
    if (reply) {
      await db.from("vz_tasks").update({ answered_at: now })
        .eq("field", field).eq("from_id", to.tg_id).eq("to_id", me.tg_id).eq("is_reply", false);
    }
    const name = me.name ?? "Автор";
    const caption = reply
      ? `${name} ответил(а) вам взаимностью: ${LABEL[field]}.`
      : `${name} выполнил(а) задание: ${LABEL[field]}. Ответьте взаимностью во «Взаимно».`;
    await sendPhoto(to.tg_id, bytes, caption);
    return { ok: true };
  },

  async reject(me, b) {
    const { data: t } = await db.from("vz_tasks").select("*")
      .eq("id", b.task_id).eq("to_id", me.tg_id).eq("status", "ok").maybeSingle();
    if (!t) return { error: "task" };
    await db.from("vz_tasks").update({ status: "rejected" }).eq("id", t.id);
    if (t.is_reply) {
      await db.from("vz_tasks").update({ answered_at: null })
        .eq("field", t.field).eq("from_id", me.tg_id).eq("to_id", t.from_id).eq("is_reply", false);
    }
    await send(t.from_id, `${me.name ?? "Автор"} не принял(а) ваш скрин: ${LABEL[t.field as Field]}. Пришлите скрин заново.`);
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
      items.push({
        id: t.id,
        kind: mine ? "resend" : !t.is_reply && !t.answered_at ? "reply" : "received",
        is_reply: t.is_reply,
        card: await card(other, t.field),
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
    await send(t.to_id, `Напоминание: ${from?.name ?? "автор"} ждёт ответа взаимностью (${LABEL[t.field as Field]}).`);
    await db.from("vz_tasks").update({ reminded_at: new Date().toISOString() }).eq("id", t.id);
  }
  const { data: notify } = await base().is("notified_at", null)
    .lt("created_at", new Date(now - 48 * H).toISOString()).limit(100);
  for (const t of notify ?? []) {
    const to = await getUser(t.to_id);
    await send(t.from_id, `${to?.name ?? "Автор"} пока не ответил(а) вам взаимностью (${LABEL[t.field as Field]}).`);
    await db.from("vz_tasks").update({ notified_at: new Date().toISOString() }).eq("id", t.id);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);

  if (req.headers.get("x-telegram-bot-api-secret-token") === SECRET) {
    if (url.searchParams.has("cron")) await cron();
    else if (url.searchParams.has("setup")) {
      await tg("setWebhook", { url: `${url.origin}/functions/v1/vzaimno`, secret_token: SECRET, allowed_updates: ["message"] });
      await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Взаимно", web_app: { url: WEBAPP_URL } } });
    } else await onBotUpdate(await req.json()).catch(console.error);
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
  const fn = actions[b.action];
  if (!fn) return json({ error: "action" }, 400);
  try {
    return json(await fn(me, b));
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
