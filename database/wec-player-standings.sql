CREATE OR REPLACE FUNCTION private.player_leaderboard(p_season integer, p_competition text)
 RETURNS TABLE(rank_position bigint, username text, points numeric, scored_picks bigint, is_you boolean, total_players bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 return query
 with totals as (
 select s.user_id,coalesce(nullif(p.username,''),'Player') as player_name,sum(s.points) as total,count(*) as entries
 from public.pick_scores s join public.fantasy_markets m on m.id=s.market_id
 left join public.profiles p on p.id=s.user_id
 where m.season=p_season and m.status='settled'
 and ((p_competition is null and s.overall) or (p_competition is not null and (m.competition_code=p_competition or (p_competition='WEC' and m.competition_code in ('WEC-HYPERCAR','WEC-LMGT3')))))
 group by s.user_id,p.username
 ), ranked as (
 select rank() over(order by t.total desc) as place,t.*,row_number() over(order by t.total desc,t.player_name,t.user_id) as display_order,count(*) over() as player_count from totals t
 )
 select r.place,r.player_name,r.total,r.entries,r.user_id=auth.uid(),r.player_count
 from ranked r where r.display_order<=100 or r.user_id=auth.uid()
 order by r.display_order;
end $function$
