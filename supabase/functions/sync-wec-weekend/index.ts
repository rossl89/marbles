import {createClient} from "https://esm.sh/@supabase/supabase-js@2.57.4";
const TOKEN=Deno.env.get("F1_SYNC_TOKEN");
Deno.serve(async req=>{
 if(!TOKEN||req.headers.get("x-sync-token")!==TOKEN)return new Response("Unauthorized",{status:401});
 try{
 const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
 const check=(r:any)=>{if(r.error)throw Error(r.error.message);return r.data;};
 const response=await fetch("https://marbles-three.vercel.app/api/wec",{signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error("WEC API "+response.status);const d=await response.json();
 for(const h of d.history||[]){
 if(!Array.isArray(h.results)||h.results.length<30||new Set(h.results.map((x:any)=>x.class+"|"+x.number)).size!==h.results.length)throw Error("Incomplete WEC classification");
 check(await sb.from("wec_result_snapshots").upsert({season:d.season,round:h.round,race_name:h.event,race_date:h.date,race_results:h.results,source:h.source,validated:true,updated_at:new Date().toISOString()},{onConflict:"season,round"}));
 }
 const settled=check(await sb.rpc("settle_wec"));
 if(d.nextEvent&&d.lockAt&&!d.stale){
 for(const cls of ["Hypercar","LMGT3"]){
 const competition_code=cls==="Hypercar"?"WEC-HYPERCAR":"WEC-LMGT3";
 const entries=d.entries.filter((x:any)=>x.class===cls);
 if(entries.length<(cls==="Hypercar"?17:18))throw Error("Incomplete WEC grid");
 const previous=check(await sb.from("fantasy_markets").select("*").eq("competition_code",competition_code).eq("season",d.season).eq("round",d.nextEvent.round).maybeSingle());
 // Do not change a published grid or price after its deadline, or recreate an elapsed market.
 if(previous&&(previous.status==="settled"||Date.parse(previous.lock_at)<=Date.now()))continue;
 if(!previous&&Date.parse(d.lockAt)<=Date.now())continue;
 const multipliers=Object.fromEntries(entries.map((x:any)=>[x.number,{name:x.team+" #"+x.number,multiplier:x.multiplier}]));
 check(await sb.from("fantasy_markets").upsert({competition_code,season:d.season,round:d.nextEvent.round,name:d.nextEvent.name+" · "+cls,lock_at:d.lockAt,status:"open",multipliers},{onConflict:"competition_code,season,round"}));
 }
 }
 return Response.json({ok:true,rounds:d.history?.length,settled,nextRound:d.nextEvent?.round||null});
 }catch(e){console.error(String(e));return Response.json({error:String(e)},{status:500});}
});