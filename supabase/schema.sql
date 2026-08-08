-- Bouquet Tool / Supabase schema
-- Run this entire file in Supabase SQL Editor on a new project.

create extension if not exists pgcrypto;

create table if not exists public.bouquet_sessions (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  name text not null check (char_length(name) between 1 and 80),
  owner_user_id uuid not null,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.bouquet_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.bouquet_sessions(id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 40),
  joined_at timestamptz not null default now(),
  unique (session_id, user_id)
);

create table if not exists public.bouquet_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  session_id uuid not null references public.bouquet_sessions(id) on delete cascade,
  actor_participant_id uuid not null references public.bouquet_participants(id) on delete cascade,
  target_participant_id uuid references public.bouquet_participants(id) on delete cascade,
  action_type text not null check (action_type in ('throw', 'use')),
  amount integer not null check (amount between 1 and 999),
  created_at timestamptz not null default now(),
  check (
    (action_type = 'throw' and target_participant_id is not null and target_participant_id <> actor_participant_id)
    or
    (action_type = 'use' and target_participant_id = actor_participant_id)
  )
);

create index if not exists bouquet_participants_session_idx on public.bouquet_participants(session_id);
create index if not exists bouquet_events_session_created_idx on public.bouquet_events(session_id, created_at desc);
create index if not exists bouquet_events_target_idx on public.bouquet_events(target_participant_id);
create index if not exists bouquet_events_actor_idx on public.bouquet_events(actor_participant_id);

alter table public.bouquet_sessions enable row level security;
alter table public.bouquet_participants enable row level security;
alter table public.bouquet_events enable row level security;

-- Helper: current authenticated user participates in this session.
create or replace function public.is_bouquet_session_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bouquet_participants p
    where p.session_id = p_session_id and p.user_id = auth.uid()
  );
$$;

revoke all on function public.is_bouquet_session_member(uuid) from public;
grant execute on function public.is_bouquet_session_member(uuid) to authenticated;

-- RLS: participants can read their session, participants and events.
drop policy if exists "bouquet sessions readable by members" on public.bouquet_sessions;
create policy "bouquet sessions readable by members"
on public.bouquet_sessions for select to authenticated
using (public.is_bouquet_session_member(id));

drop policy if exists "bouquet participants readable by members" on public.bouquet_participants;
create policy "bouquet participants readable by members"
on public.bouquet_participants for select to authenticated
using (public.is_bouquet_session_member(session_id));

drop policy if exists "bouquet events readable by members" on public.bouquet_events;
create policy "bouquet events readable by members"
on public.bouquet_events for select to authenticated
using (public.is_bouquet_session_member(session_id));

-- Do not allow direct browser writes. All writes go through SECURITY DEFINER RPC functions.
revoke insert, update, delete on public.bouquet_sessions from anon, authenticated;
revoke insert, update, delete on public.bouquet_participants from anon, authenticated;
revoke insert, update, delete on public.bouquet_events from anon, authenticated;
grant select on public.bouquet_sessions, public.bouquet_participants, public.bouquet_events to authenticated;

-- Generate a short, unambiguous, unique room code.
create or replace function public.generate_bouquet_room_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i integer;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.bouquet_sessions s where s.room_code = code);
  end loop;
  return code;
end;
$$;

-- Create a session and its GM participant.
create or replace function public.create_bouquet_session(p_name text, p_gm_display_name text)
returns table(session_id uuid, room_code text, participant_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session uuid;
  v_code text;
  v_participant uuid;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED'; end if;
  p_name := btrim(p_name);
  p_gm_display_name := btrim(p_gm_display_name);
  if p_name = '' or char_length(p_name) > 80 then raise exception 'SESSION_NAME_REQUIRED'; end if;
  if p_gm_display_name = '' or char_length(p_gm_display_name) > 40 then raise exception 'DISPLAY_NAME_REQUIRED'; end if;

  v_code := public.generate_bouquet_room_code();
  insert into public.bouquet_sessions(room_code, name, owner_user_id)
  values (v_code, p_name, v_user)
  returning id into v_session;

  insert into public.bouquet_participants(session_id, user_id, display_name)
  values (v_session, v_user, p_gm_display_name)
  returning id into v_participant;

  return query select v_session, v_code, v_participant;
end;
$$;

-- Join or resume the same authenticated user in a room.
create or replace function public.join_bouquet_session(p_room_code text, p_display_name text)
returns table(session_id uuid, room_code text, participant_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session public.bouquet_sessions%rowtype;
  v_participant uuid;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED'; end if;
  p_room_code := upper(btrim(p_room_code));
  p_display_name := btrim(p_display_name);
  if p_display_name = '' or char_length(p_display_name) > 40 then raise exception 'DISPLAY_NAME_REQUIRED'; end if;

  select * into v_session from public.bouquet_sessions s where s.room_code = p_room_code;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'active' then raise exception 'SESSION_ENDED'; end if;

  insert into public.bouquet_participants(session_id, user_id, display_name)
  values (v_session.id, v_user, p_display_name)
  on conflict on constraint bouquet_participants_session_id_user_id_key
  do update set display_name = excluded.display_name
  returning id into v_participant;

  return query select v_session.id, v_session.room_code, v_participant;
end;
$$;

create or replace function public.resume_bouquet_session(p_room_code text)
returns table(session_id uuid, room_code text, participant_id uuid)
language sql
security definer
set search_path = public
as $$
  select s.id, s.room_code, p.id
  from public.bouquet_sessions s
  join public.bouquet_participants p on p.session_id = s.id and p.user_id = auth.uid()
  where s.room_code = upper(btrim(p_room_code))
  limit 1;
$$;

-- Current balance = received throws - own uses.
create or replace function public.bouquet_participant_balance(p_participant_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(
    case
      when e.action_type = 'throw' and e.target_participant_id = p_participant_id then e.amount
      when e.action_type = 'use' and e.actor_participant_id = p_participant_id then -e.amount
      else 0
    end
  ), 0)::bigint
  from public.bouquet_events e
  where e.target_participant_id = p_participant_id or e.actor_participant_id = p_participant_id;
$$;

create or replace function public.get_bouquet_session_state(p_room_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_session public.bouquet_sessions%rowtype;
  v_me public.bouquet_participants%rowtype;
  v_participants jsonb;
  v_total bigint;
begin
  select * into v_session from public.bouquet_sessions s where s.room_code = upper(btrim(p_room_code));
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;

  select * into v_me from public.bouquet_participants p
  where p.session_id = v_session.id and p.user_id = auth.uid();
  if not found then raise exception 'NOT_SESSION_MEMBER'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'joined_at', p.joined_at,
      'balance', public.bouquet_participant_balance(p.id)
    ) order by p.joined_at, p.id), '[]'::jsonb)
  into v_participants
  from public.bouquet_participants p
  where p.session_id = v_session.id;

  select coalesce(sum((x->>'balance')::bigint),0) into v_total
  from jsonb_array_elements(v_participants) x;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id,
      'room_code', v_session.room_code,
      'name', v_session.name,
      'status', v_session.status,
      'is_owner', v_session.owner_user_id = auth.uid(),
      'total_balance', v_total
    ),
    'me', jsonb_build_object(
      'id', v_me.id,
      'display_name', v_me.display_name
    ),
    'participants', v_participants
  );
end;
$$;

-- Serialize actions per actor. This protects use operations across rapid clicks/tabs.
create or replace function public.perform_bouquet_action(
  p_session_id uuid,
  p_target_participant_id uuid,
  p_action_type text,
  p_amount integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.bouquet_sessions%rowtype;
  v_actor public.bouquet_participants%rowtype;
  v_target public.bouquet_participants%rowtype;
  v_balance bigint;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_amount < 1 or p_amount > 999 then raise exception 'INVALID_AMOUNT'; end if;
  if p_action_type not in ('throw','use') then raise exception 'INVALID_ACTION'; end if;

  -- Idempotency: a retried request with the same request_id is harmless.
  if exists (select 1 from public.bouquet_events e where e.request_id = p_request_id) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select * into v_session from public.bouquet_sessions s where s.id = p_session_id;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'active' then raise exception 'SESSION_ENDED'; end if;

  select * into v_actor from public.bouquet_participants p
  where p.session_id = p_session_id and p.user_id = auth.uid();
  if not found then raise exception 'NOT_SESSION_MEMBER'; end if;

  -- Serialize all actions by this actor (works across tabs/devices for this auth user).
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id::text, 0));

  select * into v_target from public.bouquet_participants p
  where p.id = p_target_participant_id and p.session_id = p_session_id;
  if not found then raise exception 'INVALID_TARGET'; end if;

  if p_action_type = 'throw' then
    if v_target.id = v_actor.id then raise exception 'CANNOT_THROW_TO_SELF'; end if;
  else
    if v_target.id <> v_actor.id then raise exception 'INVALID_TARGET'; end if;
    v_balance := public.bouquet_participant_balance(v_actor.id);
    if v_balance < p_amount then raise exception 'INSUFFICIENT_BOUQUET'; end if;
  end if;

  insert into public.bouquet_events(request_id, session_id, actor_participant_id, target_participant_id, action_type, amount)
  values (p_request_id, p_session_id, v_actor.id, v_target.id, p_action_type, p_amount);

  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

create or replace function public.get_bouquet_history(p_session_id uuid, p_limit integer default 2000)
returns table(created_at timestamptz, actor_name text, target_name text, action_type text, amount integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_bouquet_session_member(p_session_id) then raise exception 'NOT_SESSION_MEMBER'; end if;
  return query
    select e.created_at, actor.display_name, target.display_name, e.action_type, e.amount
    from public.bouquet_events e
    join public.bouquet_participants actor on actor.id = e.actor_participant_id
    left join public.bouquet_participants target on target.id = e.target_participant_id
    where e.session_id = p_session_id
    order by e.created_at desc, e.id desc
    limit greatest(1, least(coalesce(p_limit,2000), 10000));
end;
$$;

create or replace function public.rename_bouquet_session(p_session_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  p_name := btrim(p_name);
  if p_name = '' or char_length(p_name) > 80 then raise exception 'SESSION_NAME_REQUIRED'; end if;
  update public.bouquet_sessions s
  set name = p_name
  where s.id = p_session_id and s.owner_user_id = auth.uid();
  if not found then raise exception 'NOT_SESSION_OWNER'; end if;
end;
$$;

create or replace function public.end_bouquet_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bouquet_sessions s
  set status = 'ended', ended_at = coalesce(ended_at, now())
  where s.id = p_session_id and s.owner_user_id = auth.uid();
  if not found then raise exception 'NOT_SESSION_OWNER'; end if;
end;
$$;

-- RPC permissions
revoke all on function public.generate_bouquet_room_code() from public;
revoke all on function public.create_bouquet_session(text,text) from public;
revoke all on function public.join_bouquet_session(text,text) from public;
revoke all on function public.resume_bouquet_session(text) from public;
revoke all on function public.bouquet_participant_balance(uuid) from public;
revoke all on function public.get_bouquet_session_state(text) from public;
revoke all on function public.perform_bouquet_action(uuid,uuid,text,integer,uuid) from public;
revoke all on function public.get_bouquet_history(uuid,integer) from public;
revoke all on function public.rename_bouquet_session(uuid,text) from public;
revoke all on function public.end_bouquet_session(uuid) from public;

grant execute on function public.create_bouquet_session(text,text) to authenticated;
grant execute on function public.join_bouquet_session(text,text) to authenticated;
grant execute on function public.resume_bouquet_session(text) to authenticated;
grant execute on function public.get_bouquet_session_state(text) to authenticated;
grant execute on function public.perform_bouquet_action(uuid,uuid,text,integer,uuid) to authenticated;
grant execute on function public.get_bouquet_history(uuid,integer) to authenticated;
grant execute on function public.rename_bouquet_session(uuid,text) to authenticated;
grant execute on function public.end_bouquet_session(uuid) to authenticated;

-- Realtime publication. Safe to re-run.
do $$
begin
  begin alter publication supabase_realtime add table public.bouquet_sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.bouquet_participants; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.bouquet_events; exception when duplicate_object then null; end;
end $$;
