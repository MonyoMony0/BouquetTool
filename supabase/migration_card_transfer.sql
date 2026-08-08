-- Bouquet Tool / existing database migration
-- Adds GM-only participant card migration and hard session deletion.
-- Run this entire file once in Supabase SQL Editor on the existing project.

alter table public.bouquet_participants
  add column if not exists is_active boolean not null default true,
  add column if not exists migrated_to_participant_id uuid,
  add column if not exists migrated_at timestamptz;

create table if not exists public.bouquet_card_migrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.bouquet_sessions(id) on delete cascade,
  actor_participant_id uuid not null references public.bouquet_participants(id) on delete cascade,
  source_participant_id uuid not null references public.bouquet_participants(id) on delete cascade,
  target_participant_id uuid not null references public.bouquet_participants(id) on delete cascade,
  source_name text not null,
  target_name text not null,
  amount integer not null check (amount >= 0),
  created_at timestamptz not null default now(),
  check (source_participant_id <> target_participant_id)
);

create index if not exists bouquet_card_migrations_session_created_idx
  on public.bouquet_card_migrations(session_id, created_at desc);

alter table public.bouquet_card_migrations enable row level security;

drop policy if exists "bouquet migrations readable by members" on public.bouquet_card_migrations;
create policy "bouquet migrations readable by members"
on public.bouquet_card_migrations for select to authenticated
using (public.is_bouquet_session_member(session_id));

revoke insert, update, delete on public.bouquet_card_migrations from anon, authenticated;
grant select on public.bouquet_card_migrations to authenticated;

create or replace function public.is_bouquet_session_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bouquet_participants p
    where p.session_id = p_session_id
      and p.user_id = auth.uid()
      and p.is_active
  );
$$;

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

  if exists (
    select 1 from public.bouquet_participants p
    where p.session_id = v_session.id and p.user_id = v_user and not p.is_active
  ) then
    raise exception 'PARTICIPANT_MIGRATED';
  end if;

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
  join public.bouquet_participants p
    on p.session_id = s.id
   and p.user_id = auth.uid()
   and p.is_active
  where s.room_code = upper(btrim(p_room_code))
  limit 1;
$$;

create or replace function public.bouquet_participant_balance(p_participant_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((
      select sum(
        case
          when e.action_type = 'throw' and e.target_participant_id = p_participant_id then e.amount
          when e.action_type = 'use' and e.actor_participant_id = p_participant_id then -e.amount
          else 0
        end
      )::bigint
      from public.bouquet_events e
      where e.target_participant_id = p_participant_id or e.actor_participant_id = p_participant_id
    ), 0)
    + coalesce((
      select sum(m.amount)::bigint
      from public.bouquet_card_migrations m
      where m.target_participant_id = p_participant_id
    ), 0);
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
  where p.session_id = v_session.id and p.user_id = auth.uid() and p.is_active;
  if not found then raise exception 'NOT_SESSION_MEMBER'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'joined_at', p.joined_at,
      'balance', public.bouquet_participant_balance(p.id)
    ) order by p.joined_at, p.id), '[]'::jsonb)
  into v_participants
  from public.bouquet_participants p
  where p.session_id = v_session.id and p.is_active;

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
    'me', jsonb_build_object('id', v_me.id, 'display_name', v_me.display_name),
    'participants', v_participants
  );
end;
$$;

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

  if exists (select 1 from public.bouquet_events e where e.request_id = p_request_id) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select * into v_session from public.bouquet_sessions s where s.id = p_session_id;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'active' then raise exception 'SESSION_ENDED'; end if;

  select * into v_actor from public.bouquet_participants p
  where p.session_id = p_session_id and p.user_id = auth.uid() and p.is_active;
  if not found then raise exception 'NOT_SESSION_MEMBER'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id::text, 0));

  select * into v_target from public.bouquet_participants p
  where p.id = p_target_participant_id and p.session_id = p_session_id and p.is_active;
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
    select h.created_at, h.actor_name, h.target_name, h.action_type, h.amount
    from (
      select e.id as sort_id, e.created_at, actor.display_name as actor_name,
             target.display_name as target_name, e.action_type, e.amount
      from public.bouquet_events e
      join public.bouquet_participants actor on actor.id = e.actor_participant_id
      left join public.bouquet_participants target on target.id = e.target_participant_id
      where e.session_id = p_session_id
      union all
      select m.id as sort_id, m.created_at, actor.display_name as actor_name,
             ('カード移行：' || m.source_name || ' → ' || m.target_name)::text as target_name,
             'migrate'::text as action_type, m.amount
      from public.bouquet_card_migrations m
      join public.bouquet_participants actor on actor.id = m.actor_participant_id
      where m.session_id = p_session_id
    ) h
    order by h.created_at desc, h.sort_id desc
    limit greatest(1, least(coalesce(p_limit,2000), 10000));
end;
$$;

create or replace function public.migrate_bouquet_participant(
  p_session_id uuid,
  p_source_participant_id uuid,
  p_target_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.bouquet_sessions%rowtype;
  v_actor public.bouquet_participants%rowtype;
  v_source public.bouquet_participants%rowtype;
  v_target public.bouquet_participants%rowtype;
  v_amount bigint;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_source_participant_id = p_target_participant_id then raise exception 'INVALID_MIGRATION'; end if;

  select * into v_session from public.bouquet_sessions s where s.id = p_session_id;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.owner_user_id <> auth.uid() then raise exception 'NOT_SESSION_OWNER'; end if;
  if v_session.status <> 'active' then raise exception 'SESSION_ENDED'; end if;

  select * into v_actor from public.bouquet_participants p
  where p.session_id = p_session_id and p.user_id = auth.uid() and p.is_active;
  if not found then raise exception 'NOT_SESSION_MEMBER'; end if;
  if v_actor.id = p_source_participant_id then raise exception 'CANNOT_MIGRATE_CURRENT_GM'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  select * into v_source from public.bouquet_participants p
  where p.id = p_source_participant_id and p.session_id = p_session_id and p.is_active
  for update;
  if not found then raise exception 'INVALID_MIGRATION'; end if;

  select * into v_target from public.bouquet_participants p
  where p.id = p_target_participant_id and p.session_id = p_session_id and p.is_active
  for update;
  if not found then raise exception 'INVALID_MIGRATION'; end if;

  v_amount := public.bouquet_participant_balance(v_source.id);
  if v_amount > 2147483647 then raise exception 'MIGRATION_AMOUNT_TOO_LARGE'; end if;

  insert into public.bouquet_card_migrations(
    session_id, actor_participant_id, source_participant_id, target_participant_id,
    source_name, target_name, amount
  ) values (
    p_session_id, v_actor.id, v_source.id, v_target.id,
    v_source.display_name, v_target.display_name, v_amount::integer
  );

  update public.bouquet_participants p
  set is_active = false,
      migrated_to_participant_id = v_target.id,
      migrated_at = now()
  where p.id = v_source.id;

  return jsonb_build_object('ok', true, 'amount', v_amount, 'target_participant_id', v_target.id);
end;
$$;

create or replace function public.delete_bouquet_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.bouquet_sessions s
  where s.id = p_session_id and s.owner_user_id = auth.uid();
  if not found then raise exception 'NOT_SESSION_OWNER'; end if;
end;
$$;

revoke all on function public.migrate_bouquet_participant(uuid,uuid,uuid) from public;
revoke all on function public.delete_bouquet_session(uuid) from public;
grant execute on function public.migrate_bouquet_participant(uuid,uuid,uuid) to authenticated;
grant execute on function public.delete_bouquet_session(uuid) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.bouquet_card_migrations; exception when duplicate_object then null; end;
end $$;
