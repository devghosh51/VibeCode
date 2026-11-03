-- Run this entire script in Supabase Dashboard → SQL Editor → New query.
-- Then enable Anonymous Sign-Ins: Authentication → Providers → Anonymous Sign-Ins.
-- IMPORTANT: do not expose your service_role key in config.js or GitHub.

create extension if not exists pgcrypto;

create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  room_name text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 1 and 30),
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_room_created_idx
  on public.chat_messages(room_id, created_at);

alter table public.chat_rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.chat_messages enable row level security;

-- Room passwords are never readable by the browser. Room access is granted only by RPC.
revoke all on public.chat_rooms from anon, authenticated;
revoke all on public.room_members from anon, authenticated;
grant select on public.room_members to authenticated;
grant select, insert on public.chat_messages to authenticated;
grant usage, select on sequence public.chat_messages_id_seq to authenticated;

create or replace function public.create_chat_room(p_room_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_room_id uuid;
  clean_name text := btrim(p_room_name);
begin
  if auth.uid() is null then raise exception 'Please sign in and try again.'; end if;
  if clean_name is null or char_length(clean_name) < 2 or char_length(clean_name) > 40 then
    raise exception 'Room name must be 2–40 characters.';
  end if;
  if p_password is null or char_length(p_password) < 6 or char_length(p_password) > 72 then
    raise exception 'Password must be 6–72 characters.';
  end if;

  insert into public.chat_rooms(room_name, password_hash)
  values (clean_name, crypt(p_password, gen_salt('bf')))
  returning id into new_room_id;

  insert into public.room_members(room_id, user_id) values (new_room_id, auth.uid());
  return new_room_id;
exception when unique_violation then
  raise exception 'That room ID is already taken. Choose another one.';
end;
$$;

create or replace function public.join_chat_room(p_room_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  found_room public.chat_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Please sign in and try again.'; end if;
  select * into found_room from public.chat_rooms where room_name = btrim(p_room_name);
  if not found then raise exception 'Room not found or password is incorrect.'; end if;
  if found_room.password_hash <> crypt(p_password, found_room.password_hash) then
    raise exception 'Room not found or password is incorrect.';
  end if;
  insert into public.room_members(room_id, user_id)
  values (found_room.id, auth.uid())
  on conflict do nothing;
  return found_room.id;
end;
$$;

revoke all on function public.create_chat_room(text, text) from public;
revoke all on function public.join_chat_room(text, text) from public;
grant execute on function public.create_chat_room(text, text) to authenticated;
grant execute on function public.join_chat_room(text, text) to authenticated;

drop policy if exists "users can read own memberships" on public.room_members;
create policy "users can read own memberships"
on public.room_members for select to authenticated
using (user_id = auth.uid());

drop policy if exists "members can read room messages" on public.chat_messages;
create policy "members can read room messages"
on public.chat_messages for select to authenticated
using (exists (
  select 1 from public.room_members m
  where m.room_id = chat_messages.room_id and m.user_id = auth.uid()
));

drop policy if exists "members can send room messages as themselves" on public.chat_messages;
create policy "members can send room messages as themselves"
on public.chat_messages for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.room_members m
    where m.room_id = chat_messages.room_id and m.user_id = auth.uid()
  )
);

-- Enable Realtime for the messages table in Supabase:
-- Database → Publications → supabase_realtime → add chat_messages.
