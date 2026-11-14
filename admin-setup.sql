-- =====================================================================
-- ADMIN PANEL SETUP  (run once in Supabase → SQL Editor → New query)
-- Safe to run again. Does not change your existing chat tables.
-- =====================================================================

-- 1) Who is an admin
create table if not exists public.chat_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.chat_admins enable row level security;
revoke all on public.chat_admins from anon, authenticated;   -- only reachable through the functions below

create or replace function public.is_chat_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$ select exists (select 1 from public.chat_admins a where a.user_id = auth.uid()); $$;

-- 2) Dashboard numbers
create or replace function public.admin_stats()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare result jsonb;
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  select jsonb_build_object(
    'rooms',           (select count(*) from public.chat_rooms),
    'members',         (select count(*) from public.room_members),
    'users',           (select count(distinct m.user_id) from public.room_members m),
    'messages',        (select count(*) from public.chat_messages),
    'messages_24h',    (select count(*) from public.chat_messages m where m.created_at > now() - interval '24 hours'),
    'active_rooms_7d', (select count(distinct m.room_id) from public.chat_messages m where m.created_at > now() - interval '7 days'),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0)) order by g.d), '[]'::jsonb)
      from generate_series(current_date - 6, current_date, interval '1 day') as g(d)
      left join (
        select m.created_at::date as day, count(*) as cnt
        from public.chat_messages m
        where m.created_at >= current_date - 6
        group by 1
      ) c on c.day = g.d::date
    )
  ) into result;
  return result;
end;
$$;

-- 3) Rooms
create or replace function public.admin_list_rooms()
returns table (room_id uuid, room_name text, created_at timestamptz, member_count bigint, message_count bigint, last_message_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  return query
  select r.id, r.room_name, r.created_at,
         (select count(*) from public.room_members m where m.room_id = r.id),
         (select count(*) from public.chat_messages c where c.room_id = r.id),
         (select max(c.created_at) from public.chat_messages c where c.room_id = r.id)
  from public.chat_rooms r
  order by r.created_at desc;
end;
$$;

create or replace function public.admin_list_members(p_room uuid)
returns table (user_id uuid, joined_at timestamptz, message_count bigint, last_username text, last_message_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  return query
  select m.user_id, m.joined_at,
         (select count(*) from public.chat_messages c where c.room_id = m.room_id and c.user_id = m.user_id),
         (select c.username from public.chat_messages c where c.room_id = m.room_id and c.user_id = m.user_id order by c.created_at desc limit 1),
         (select max(c.created_at) from public.chat_messages c where c.room_id = m.room_id and c.user_id = m.user_id)
  from public.room_members m
  where m.room_id = p_room
  order by m.joined_at;
end;
$$;

-- 4) Messages
create or replace function public.admin_list_messages(p_room uuid, p_before timestamptz default null, p_limit int default 100)
returns table (id bigint, user_id uuid, username text, content text, created_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  return query
  select c.id, c.user_id, c.username, c.content, c.created_at
  from public.chat_messages c
  where c.room_id = p_room and (p_before is null or c.created_at < p_before)
  order by c.created_at desc, c.id desc
  limit least(greatest(p_limit, 1), 1000);
end;
$$;

create or replace function public.admin_search_messages(p_query text, p_limit int default 50)
returns table (id bigint, room_id uuid, room_name text, user_id uuid, username text, content text, created_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare q text := lower(btrim(coalesce(p_query, '')));
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  if char_length(q) = 0 then return; end if;
  return query
  select c.id, c.room_id, r.room_name, c.user_id, c.username, c.content, c.created_at
  from public.chat_messages c
  join public.chat_rooms r on r.id = c.room_id
  where position(q in lower(c.content)) > 0 or position(q in lower(c.username)) > 0
  order by c.created_at desc
  limit least(greatest(p_limit, 1), 200);
end;
$$;

create or replace function public.admin_delete_message(p_id bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  delete from public.chat_messages where id = p_id;
end;
$$;

create or replace function public.admin_clear_room_messages(p_room uuid)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare n bigint;
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  with d as (delete from public.chat_messages c where c.room_id = p_room returning 1)
  select count(*) into n from d;
  return n;
end;
$$;

-- 5) Room / member management
create or replace function public.admin_delete_room(p_room uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  delete from public.chat_rooms where id = p_room;   -- members and messages are removed by cascade
end;
$$;

create or replace function public.admin_remove_member(p_room uuid, p_user uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  delete from public.room_members where room_id = p_room and user_id = p_user;
end;
$$;

create or replace function public.admin_rename_room(p_room uuid, p_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare clean text := btrim(p_name);
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  if clean is null or char_length(clean) < 2 or char_length(clean) > 40 then
    raise exception 'Room name must be 2–40 characters.';
  end if;
  update public.chat_rooms set room_name = clean where id = p_room;
  if not found then raise exception 'Room not found.'; end if;
exception when unique_violation then
  raise exception 'That room ID is already taken.';
end;
$$;

create or replace function public.admin_set_room_password(p_room uuid, p_password text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if not public.is_chat_admin() then raise exception 'Not authorized'; end if;
  if p_password is null or char_length(p_password) < 6 or char_length(p_password) > 72 then
    raise exception 'Password must be 6–72 characters.';
  end if;
  update public.chat_rooms set password_hash = crypt(p_password, gen_salt('bf')) where id = p_room;
  if not found then raise exception 'Room not found.'; end if;
end;
$$;

-- 6) Only signed-in users may call these (and each one re-checks is_chat_admin())
revoke all on function public.is_chat_admin() from public;
revoke all on function public.admin_stats() from public;
revoke all on function public.admin_list_rooms() from public;
revoke all on function public.admin_list_members(uuid) from public;
revoke all on function public.admin_list_messages(uuid, timestamptz, int) from public;
revoke all on function public.admin_search_messages(text, int) from public;
revoke all on function public.admin_delete_message(bigint) from public;
revoke all on function public.admin_clear_room_messages(uuid) from public;
revoke all on function public.admin_delete_room(uuid) from public;
revoke all on function public.admin_remove_member(uuid, uuid) from public;
revoke all on function public.admin_rename_room(uuid, text) from public;
revoke all on function public.admin_set_room_password(uuid, text) from public;

grant execute on function public.is_chat_admin() to authenticated;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_list_rooms() to authenticated;
grant execute on function public.admin_list_members(uuid) to authenticated;
grant execute on function public.admin_list_messages(uuid, timestamptz, int) to authenticated;
grant execute on function public.admin_search_messages(text, int) to authenticated;
grant execute on function public.admin_delete_message(bigint) to authenticated;
grant execute on function public.admin_clear_room_messages(uuid) to authenticated;
grant execute on function public.admin_delete_room(uuid) to authenticated;
grant execute on function public.admin_remove_member(uuid, uuid) to authenticated;
grant execute on function public.admin_rename_room(uuid, text) to authenticated;
grant execute on function public.admin_set_room_password(uuid, text) to authenticated;

-- =====================================================================
-- LAST STEP (run separately, after creating your admin login):
--   Supabase → Authentication → Users → Add user  (email + strong password, auto-confirm)
-- Then run this with YOUR email:
--
--   insert into public.chat_admins (user_id)
--   select id from auth.users where email = 'you@example.com'
--   on conflict do nothing;
-- =====================================================================
