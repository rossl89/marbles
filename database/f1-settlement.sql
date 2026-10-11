alter table public.fantasy_markets add column if not exists season integer, add column if not exists round integer, add column if not exists multipliers jsonb not null default '{}'::jsonb;
update public.fantasy_markets set season=2026,round=17 where competition_code='F1' and name='Singapore Grand Prix' and round is null;
create unique index if not exists fantasy_market_round on public.fantasy_markets(competition_code,season,round);
create table if not exists public.pick_scores(
 pick_id uuid primary key references public.picks(id), user_id uuid not null references auth.users(id),
 market_id uuid not null references public.fantasy_markets(id), race_base numeric not null,sprint_base numeric not null,
 effective_multiplier numeric not null,points numeric not null,overall boolean not null,updated_at timestamptz not null default now());
alter table public.pick_scores enable row level security;
create policy own_scores on public.pick_scores for select to authenticated using ((select auth.uid())=user_id);
grant select on public.pick_scores to authenticated;
revoke all on public.pick_scores from anon;
create or replace function public.fantasy_base_points(pos integer,status text) returns numeric language sql immutable as $$
 select case when status in ('Retired','DNS','Disqualified') then 0 else coalesce((array[100,85,72,62,54,47,41,36,31,27,23,19,15,12,9,7,5,3,2,1]::numeric[])[pos],0) end;
$$;
create or replace function public.settle_f1() returns integer language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
 insert into public.pick_scores(pick_id,user_id,market_id,race_base,sprint_base,effective_multiplier,points,overall)
 select p.id,p.user_id,m.id,
 public.fantasy_base_points((r->>'position')::int,r->>'status'),
 coalesce(public.fantasy_base_points((sp->>'position')::int,sp->>'status'),0)*0.5,
 p.multiplier+case when p.drs then 0.30 else 0 end,
 round((public.fantasy_base_points((r->>'position')::int,r->>'status')+coalesce(public.fantasy_base_points((sp->>'position')::int,sp->>'status'),0)*0.5)*(p.multiplier+case when p.drs then 0.30 else 0 end),2),p.overall
 from public.picks p join public.fantasy_markets m on m.id=p.market_id
 join public.f1_result_snapshots s on s.season=m.season and s.round=m.round and s.validated
 cross join lateral jsonb_array_elements(s.race_results) r
 left join lateral (select value as sp from jsonb_array_elements(s.sprint_results) where value->>'number'=p.competitor_key) t on true
 where m.competition_code='F1' and r->>'number'=p.competitor_key
 on conflict(pick_id) do update set race_base=excluded.race_base,sprint_base=excluded.sprint_base,effective_multiplier=excluded.effective_multiplier,points=excluded.points,overall=excluded.overall,updated_at=now();
 get diagnostics n=row_count;
 update public.fantasy_markets m set status='settled' where competition_code='F1' and exists(select 1 from public.f1_result_snapshots s where s.season=m.season and s.round=m.round and s.validated);
 update public.fantasy_markets set status='locked' where status in ('open','scheduled') and lock_at<=now();
 return n;
end $$;
revoke all on function public.settle_f1() from public,anon,authenticated;
grant execute on function public.settle_f1() to service_role;
create extension if not exists pg_cron;
create extension if not exists pg_net;

CREATE OR REPLACE FUNCTION public.submit_pick(p_market_id uuid, p_competitor_key text, p_competitor_name text, p_multiplier numeric, p_overall boolean DEFAULT false, p_drs boolean DEFAULT false)
 RETURNS picks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare uid uuid:=auth.uid(); m public.fantasy_markets; old_drs boolean:=false; result public.picks; yr int;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select * into m from public.fantasy_markets where id=p_market_id for update;
  if not found then raise exception 'Market not found'; end if;
  if m.status <> 'open' then raise exception 'Market is not open'; end if;
  if now() >= m.lock_at then raise exception 'Market is locked'; end if;
  if not (m.multipliers ? p_competitor_key) then raise exception 'Competitor not in published market'; end if;
  p_multiplier := (m.multipliers->p_competitor_key->>'multiplier')::numeric;
  p_competitor_name := m.multipliers->p_competitor_key->>'name';
  if p_multiplier < 1 or p_multiplier > 2 then raise exception 'Invalid multiplier'; end if;
  yr:=extract(year from m.lock_at)::int;
  select drs into old_drs from public.picks where user_id=uid and market_id=p_market_id;
  insert into public.drs_allocations(user_id,season_year,used) values(uid,yr,0) on conflict do nothing;
  if p_drs and not coalesce(old_drs,false) then
    update public.drs_allocations set used=used+1 where user_id=uid and season_year=yr and used<5;
    if not found then raise exception 'No DRS uses remaining'; end if;
  elsif not p_drs and coalesce(old_drs,false) then
    update public.drs_allocations set used=greatest(used-1,0) where user_id=uid and season_year=yr;
  end if;
  insert into public.picks(user_id,market_id,competitor_key,competitor_name,multiplier,overall,drs)
  values(uid,p_market_id,p_competitor_key,p_competitor_name,p_multiplier,p_overall,p_drs)
  on conflict(user_id,market_id) do update set competitor_key=excluded.competitor_key,competitor_name=excluded.competitor_name,
    multiplier=excluded.multiplier,overall=excluded.overall,drs=excluded.drs,updated_at=now()
  returning * into result;
  return result;
end $function$
;
revoke execute on function public.submit_pick(uuid,text,text,numeric,boolean,boolean) from public,anon; grant execute on function public.submit_pick(uuid,text,text,numeric,boolean,boolean) to authenticated;
alter function public.fantasy_base_points(integer,text) set search_path=public;
