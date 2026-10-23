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
    and to_jsonb(u) ->> f is not null
    and public.vz_unanswered(u.tg_id) < 10
    -- отработанная карточка больше не показывается (в любом статусе; повтор скрина идёт через «Входящие»)
    and not exists (select 1 from public.vz_tasks t where t.field = f
                    and ((t.from_id = me and t.to_id = u.tg_id) or (t.from_id = u.tg_id and t.to_id = me)))
  order by
    u.is_pinned desc,
    (u.tg_id is not distinct from (select invited_by from me_row)) desc,
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
