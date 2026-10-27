create table public.wec_result_snapshots(
season integer not null,round integer not null,race_name text not null,race_date date not null,
race_results jsonb not null check(jsonb_typeof(race_results)='array'),source text not null,validated boolean not null default false,updated_at timestamptz not null default now(),primary key(season,round));
alter table public.wec_result_snapshots enable row level security;
grant select on public.wec_result_snapshots to anon,authenticated;
grant all on public.wec_result_snapshots to service_role;
create policy wec_results_public_read on public.wec_result_snapshots for select to anon,authenticated using (validated);
create function public.settle_wec() returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
insert into public.pick_scores(pick_id,user_id,market_id,race_base,sprint_base,effective_multiplier,points,overall)
select p.id,p.user_id,m.id,public.fantasy_base_points((r->>'position')::int,r->>'status'),0,
p.multiplier+case when p.drs then .30 else 0 end,
round(public.fantasy_base_points((r->>'position')::int,r->>'status')*(p.multiplier+case when p.drs then .30 else 0 end),2),p.overall
from public.picks p join public.fantasy_markets m on m.id=p.market_id
join public.wec_result_snapshots s on s.season=m.season and s.round=m.round and s.validated
cross join lateral jsonb_array_elements(s.race_results) r
where m.competition_code=case when r->>'class'='Hypercar' then 'WEC-HYPERCAR' when r->>'class'='LMGT3' then 'WEC-LMGT3' else '' end and r->>'number'=p.competitor_key
on conflict(pick_id) do update set race_base=excluded.race_base,sprint_base=0,effective_multiplier=excluded.effective_multiplier,points=excluded.points,overall=excluded.overall,updated_at=now();
get diagnostics n=row_count;
update public.fantasy_markets m set status='settled' where m.competition_code in ('WEC-HYPERCAR','WEC-LMGT3') and exists(select 1 from public.wec_result_snapshots s where s.season=m.season and s.round=m.round and s.validated);
update public.fantasy_markets set status='locked' where status='open' and lock_at<=now();
return n;
end $$;
revoke all on function public.settle_wec() from public,anon,authenticated;
grant execute on function public.settle_wec() to service_role;
CREATE OR REPLACE FUNCTION public.submit_pick(p_market_id uuid, p_competitor_key text, p_competitor_name text, p_multiplier numeric, p_overall boolean DEFAULT false, p_drs boolean DEFAULT false)
 RETURNS picks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare uid uuid:=auth.uid(); m public.fantasy_markets; old_drs boolean:=false; result public.picks; yr int;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select * into m from public.fantasy_markets where id=p_market_id for update;
  if not found then raise exception 'Market not found'; end if;
  if m.status <> 'open' then raise exception 'Market is not open'; end if;
  if now() >= m.lock_at then raise exception 'Market is locked'; end if;
  if not (m.multipliers ? p_competitor_key) then raise exception 'Competitor not in published market'; end if;
  p_multiplier := (m.multipliers->p_competitor_key->>'multiplier')::numeric;
  p_competitor_name := m.multipliers->p_competitor_key->>'name';
  if p_multiplier < 1 or p_multiplier > 2 then raise exception 'Invalid multiplier'; end if;
  if p_overall then
    if (select count(*) from public.picks p join public.fantasy_markets fm on fm.id=p.market_id where p.user_id=uid and p.overall and p.market_id<>m.id and date_trunc('week',fm.lock_at at time zone 'Europe/London')=date_trunc('week',m.lock_at at time zone 'Europe/London'))>=3 then raise exception 'Your three Overall slots for this race weekend are filled'; end if;
    if exists(select 1 from public.picks p join public.fantasy_markets fm on fm.id=p.market_id where p.user_id=uid and p.overall and p.market_id<>m.id and fm.season=m.season and fm.round=m.round and (case when fm.competition_code like 'WEC-%' then 'WEC' else fm.competition_code end)=(case when m.competition_code like 'WEC-%' then 'WEC' else m.competition_code end)) then raise exception 'Only one Overall pick can come from the same event'; end if;
  end if;
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

