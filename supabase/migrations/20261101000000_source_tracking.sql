alter table public.vz_users
  add column source_code text
  check (source_code is null or source_code ~ '^[a-z0-9_]{1,60}$');

create function public.vz_source_stats()
returns table (
  source_code text,
  joined bigint,
  with_content bigint,
  sent_support bigint,
  received_reply bigint
)
language sql stable security invoker
set search_path = ''
as $$
  select u.source_code,
    count(*),
    count(*) filter (where coalesce(u.book, u.profile, u.tg, u.vk, u.boosty, u.tiktok, u.insta) is not null
      or exists (select 1 from public.vz_reels r where r.user_id = u.tg_id)),
    count(*) filter (where exists (
      select 1 from public.vz_tasks t where t.from_id = u.tg_id and t.status = 'ok'
    )),
    count(*) filter (where exists (
      select 1 from public.vz_tasks t where t.from_id = u.tg_id
        and t.status = 'ok' and not t.is_reply and t.answered_at is not null
    ))
  from public.vz_users u
  group by u.source_code
  order by count(*) desc, u.source_code nulls last;
$$;

revoke all on function public.vz_source_stats() from public, anon, authenticated;
grant execute on function public.vz_source_stats() to service_role;
