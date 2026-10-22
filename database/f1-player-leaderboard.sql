create schema if not exists private;
create or replace function private.f1_player_leaderboard(p_season integer)
returns table(rank_position bigint,username text,points numeric,scored_picks bigint,is_you boolean)
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 return query
 with totals as (
 select s.user_id,coalesce(p.username,'Player') as player_name,sum(s.points) as total,count(*) as entries
 from public.pick_scores s join public.fantasy_markets m on m.id=s.market_id
 left join public.profiles p on p.id=s.user_id
 where m.competition_code='F1' and m.season=p_season and s.overall and m.status='settled'
 group by s.user_id,p.username)
 select rank() over(order by t.total desc),t.player_name,t.total,t.entries,t.user_id=auth.uid()
 from totals t order by t.total desc,t.player_name limit 100;
end $$;
revoke all on function private.f1_player_leaderboard(integer) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.f1_player_leaderboard(integer) to authenticated;
create or replace function public.f1_player_leaderboard(p_season integer default 2026)
returns table(rank_position bigint,username text,points numeric,scored_picks bigint,is_you boolean)
language sql security invoker set search_path='' as $$ select * from private.f1_player_leaderboard(p_season); $$;
revoke all on function public.f1_player_leaderboard(integer) from public,anon;
grant execute on function public.f1_player_leaderboard(integer) to authenticated;