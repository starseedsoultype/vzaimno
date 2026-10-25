-- Взаимно: обмен подписками и оценками со скрином.
-- Доступ только у Edge Function (service role): RLS включён, политик нет.

create table if not exists public.vz_users (
  tg_id       bigint primary key,
  name        text,
  book        text,
  profile     text,
  tg          text,
  vk          text,
  boosty      text,
  is_pinned   boolean not null default false,
  invited_by  bigint,
  created_at  timestamptz not null default now()
);

-- Задание: from_id выполнил поле field у to_id и прислал скрин.
-- is_reply = ответ взаимностью на чужое задание.
create table if not exists public.vz_tasks (
  id          bigserial primary key,
  field       text not null check (field in ('book', 'profile', 'tg', 'vk', 'boosty')),
  from_id     bigint not null references public.vz_users (tg_id) on delete cascade,
  to_id       bigint not null references public.vz_users (tg_id) on delete cascade,
  is_reply    boolean not null default false,
  shot_path   text not null,
  status      text not null default 'ok' check (status in ('ok', 'rejected')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz,
  reminded_at timestamptz,
  notified_at timestamptz,
  unique (field, from_id, to_id, is_reply)
);
create index if not exists vz_tasks_to_idx on public.vz_tasks (to_id);

create table if not exists public.vz_skips (
  user_id    bigint not null,
  target_id  bigint not null,
  field      text not null,
  skipped_at timestamptz not null default now(),
  done       boolean not null default false,
  primary key (user_id, target_id, field)
);

alter table public.vz_users enable row level security;
alter table public.vz_tasks enable row level security;
alter table public.vz_skips enable row level security;

insert into storage.buckets (id, name, public)
values ('vz-shots', 'vz-shots', false)
on conflict (id) do nothing;

-- Неотвеченные входящие: задание принято, ответа взаимностью нет.
create or replace function public.vz_unanswered(uid bigint) returns int
language sql stable as $$
  select count(*)::int from public.vz_tasks
  where to_id = uid and not is_reply and status = 'ok' and answered_at is null
$$;

-- Лента по полю f для пользователя me, по порядку показа.
create or replace function public.vz_feed(me bigint, f text, lim int default 20)
returns setof public.vz_users
language sql stable as $$
  with me_row as (select * from public.vz_users where tg_id = me),
  stats as (
    select u.tg_id,
      (select count(*) from public.vz_tasks t where t.from_id = u.tg_id and t.status = 'ok') as given,
      (select count(*) from public.vz_tasks t where t.to_id = u.tg_id and not t.is_reply and t.status = 'ok') as got,
      (select count(*) from public.vz_tasks t where t.to_id = u.tg_id and not t.is_reply
         and t.created_at > date_trunc('day', now())) as today
    from public.vz_users u
  )
  select u.* from public.vz_users u
  join stats s on s.tg_id = u.tg_id
  left join public.vz_skips k on k.user_id = me and k.target_id = u.tg_id and k.field = f
  where u.tg_id <> me
    and not u.banned and not u.hidden
    -- отмечено вручную: «уже обменялись в чате»
    and not coalesce(k.done, false)
    and to_jsonb(u) ->> f is not null
    and public.vz_unanswered(u.tg_id) < 10
    -- отработанная карточка больше не показывается (в любом статусе; повтор скрина идёт через «Входящие»)
    and not exists (select 1 from public.vz_tasks t where t.field = f
                    and ((t.from_id = me and t.to_id = u.tg_id) or (t.from_id = u.tg_id and t.to_id = me)))
  order by
    u.is_pinned desc,
    (u.tg_id is not distinct from (select invited_by from me_row)) desc,
    (u.boost_until > now()) is true desc,
    (k.skipped_at is not null),
    k.skipped_at,
    (s.got < 3) desc,
    (s.given - s.got) desc,
    s.today,
    u.created_at
  limit lim
$$;

-- Рейтинг: доля ответов взаимностью среди входящих, где ответ есть или прошло 48 часов.
create or replace function public.vz_rating(uid bigint) returns int
language sql stable as $$
  select case when count(*) = 0 then null
    else round(100.0 * count(*) filter (where answered_at is not null) / count(*))::int end
  from public.vz_tasks
  where to_id = uid and not is_reply and status = 'ok'
    and (answered_at is not null or created_at < now() - interval '48 hours')
$$;

revoke execute on function public.vz_unanswered(bigint), public.vz_feed(bigint, text, int), public.vz_rating(bigint)
  from public, anon, authenticated;

alter table public.vz_users add column if not exists photo_url text;

-- Раз в час: напоминания 24/48 часов.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('vzaimno-hourly', '0 * * * *',
  $$select net.http_post(url := 'https://ogqtywdsplyqwfznqxnu.supabase.co/functions/v1/vzaimno?cron=1', body := '{}'::jsonb)$$);

-- Своё фото профиля (если Telegram отдаёт заглушку).
alter table public.vz_users add column if not exists photo_custom text;
insert into storage.buckets (id, name, public) values ('vz-ava', 'vz-ava', true) on conflict (id) do nothing;

-- Бонус за приглашение: первый обмен приглашённого даёт пригласившему сутки наверху ленты.
alter table public.vz_users add column if not exists boost_until timestamptz;
alter table public.vz_users add column if not exists ref_bonus_given boolean not null default false;

create or replace function public.vz_invite_bonus() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare inviter bigint;
begin
  update public.vz_users set ref_bonus_given = true
  where tg_id = new.from_id and invited_by is not null and not ref_bonus_given
  returning invited_by into inviter;
  if inviter is not null then
    update public.vz_users
    set boost_until = greatest(coalesce(boost_until, now()), now()) + interval '24 hours'
    where tg_id = inviter;
  end if;
  return new;
end $fn$;
revoke execute on function public.vz_invite_bonus() from public, anon, authenticated;

drop trigger if exists vz_invite_bonus on public.vz_tasks;
create trigger vz_invite_bonus after insert on public.vz_tasks
for each row execute function public.vz_invite_bonus();

-- Жалобы, баны, админ. После 3 жалоб от разных людей карточка скрывается до решения админа.
alter table public.vz_users add column if not exists is_admin boolean not null default false;
alter table public.vz_users add column if not exists banned boolean not null default false;
alter table public.vz_users add column if not exists hidden boolean not null default false;

create table if not exists public.vz_reports (
  id bigserial primary key,
  from_id bigint not null references public.vz_users (tg_id) on delete cascade,
  to_id bigint not null references public.vz_users (tg_id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (from_id, to_id)
);
alter table public.vz_reports enable row level security;

create or replace function public.vz_report_hide() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if (select count(distinct from_id) from public.vz_reports where to_id = new.to_id) >= 3 then
    update public.vz_users set hidden = true where tg_id = new.to_id;
  end if;
  return new;
end $fn$;
revoke execute on function public.vz_report_hide() from public, anon, authenticated;
drop trigger if exists vz_report_hide on public.vz_reports;
create trigger vz_report_hide after insert on public.vz_reports
for each row execute function public.vz_report_hide();

-- TikTok и Instagram.
alter table public.vz_users add column if not exists tiktok text;
alter table public.vz_users add column if not exists insta text;
alter table public.vz_tasks drop constraint if exists vz_tasks_field_check;
alter table public.vz_tasks add constraint vz_tasks_field_check
  check (field in ('book', 'profile', 'tg', 'vk', 'boosty', 'tiktok', 'insta'));

-- Когда человек последний раз открывал миниапп: для всплывашки «+1».
alter table public.vz_users add column if not exists last_seen_at timestamptz;

-- Жалоба на конкретный скрин (непристойный контент): админ видит сам скрин.
alter table public.vz_reports add column if not exists task_id bigint references public.vz_tasks (id) on delete set null;
alter table public.vz_reports drop constraint if exists vz_reports_from_id_to_id_key;
create unique index if not exists vz_reports_uniq on public.vz_reports (from_id, to_id, task_id) nulls not distinct;

-- Раз в день в 10:00 по Таиланду (03:00 UTC): админам число новых пользователей.
select cron.schedule('vzaimno-daily', '0 3 * * *',
  $$select net.http_post(url := 'https://ogqtywdsplyqwfznqxnu.supabase.co/functions/v1/vzaimno?daily=1', body := '{}'::jsonb)$$);

-- Рилсы: живут 48 часов, у человека до 2 активных (новый вытесняет старый через retired).
create table if not exists public.vz_reels (
  id bigserial primary key,
  user_id bigint not null references public.vz_users (tg_id) on delete cascade,
  url text not null,
  retired boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists vz_reels_user_idx on public.vz_reels (user_id, created_at desc);
alter table public.vz_reels enable row level security;

-- reel_id: какой рилс поддержали; back_reel_id: рилс отправителя, которым ему отвечают.
alter table public.vz_tasks add column if not exists reel_id bigint references public.vz_reels (id) on delete cascade;
alter table public.vz_tasks add column if not exists back_reel_id bigint references public.vz_reels (id) on delete set null;
alter table public.vz_tasks drop constraint if exists vz_tasks_field_check;
alter table public.vz_tasks add constraint vz_tasks_field_check
  check (field in ('book', 'profile', 'tg', 'vk', 'boosty', 'tiktok', 'insta', 'reel'));
alter table public.vz_tasks drop constraint if exists vz_tasks_field_from_id_to_id_is_reply_key;
create unique index if not exists vz_tasks_uniq on public.vz_tasks (field, from_id, to_id, is_reply, reel_id) nulls not distinct;

-- Лента рилсов: свежие, чужие, ещё не поддержанные и не скрытые мной.
create or replace function public.vz_reel_feed(me bigint, lim int default 20)
returns table (reel_id bigint, url text, owner bigint)
language sql stable set search_path = public as $$
  select r.id, r.url, r.user_id
  from public.vz_reels r
  join public.vz_users u on u.tg_id = r.user_id
  left join public.vz_skips k on k.user_id = me and k.target_id = r.user_id and k.field = 'reel:' || r.id
  where r.created_at > now() - interval '48 hours' and not r.retired
    and r.user_id <> me
    and not u.banned and not u.hidden
    and not coalesce(k.done, false)
    and public.vz_unanswered(u.tg_id) < 10
    and not exists (select 1 from public.vz_tasks t where t.reel_id = r.id and t.from_id = me)
    and not exists (select 1 from public.vz_tasks t where t.field = 'reel' and t.from_id = r.user_id and t.to_id = me
                    and not t.is_reply and t.answered_at is null and t.status = 'ok')
  order by
    u.is_pinned desc,
    (u.boost_until > now()) is true desc,
    (k.skipped_at is not null),
    k.skipped_at,
    (select count(*) from public.vz_tasks t where t.reel_id = r.id),
    r.created_at desc
  limit lim
$$;
revoke execute on function public.vz_reel_feed(bigint, int) from public, anon, authenticated;

-- Ежедневная сводка каждому в 10:00 по Москве (07:00 UTC); можно отключить в профиле.
alter table public.vz_users add column if not exists digest_off boolean not null default false;
select cron.schedule('vzaimno-digest', '0 7 * * *',
  $$select net.http_post(url := 'https://ogqtywdsplyqwfznqxnu.supabase.co/functions/v1/vzaimno?digest=1', body := '{}'::jsonb)$$);

-- Разовая рассылка-инструкция: кому уже отправлена.
alter table public.vz_users add column if not exists broadcast_sent boolean not null default false;

-- Сводки (daily, digest) не чаще раза в 20 часов, даже если адрес вызовут вручную.
create table if not exists public.vz_runs (name text primary key, at timestamptz not null);
alter table public.vz_runs enable row level security;
create or replace function public.vz_claim_run(job text) returns boolean
language sql volatile set search_path = public as $$
  with up as (
    insert into public.vz_runs (name, at) values (job, now())
    on conflict (name) do update set at = now() where public.vz_runs.at < now() - interval '20 hours'
    returning 1
  ) select exists (select 1 from up)
$$;
revoke execute on function public.vz_claim_run(text) from public, anon, authenticated;

-- Напоминание за 2 часа до конца жизни рилса отправлено.
alter table public.vz_reels add column if not exists reminded boolean not null default false;
