import {createClient} from "https://esm.sh/@supabase/supabase-js@2.57.4";
const TOKEN=Deno.env.get("F1_SYNC_TOKEN");
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function json(url:string){for(let i=0;i<4;i++){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(r.ok)return r.json();if(r.status!==429)throw Error("Feed HTTP "+r.status);await pause(1000*(i+1));}throw Error("Feed rate limited");}
Deno.serve(async req=>{
 if(req.headers.get("x-sync-token")!==TOKEN)return new Response("Unauthorized",{status:401});
 try{
 const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
 const check=(r:any)=>{if(r.error)throw Error(r.error.message);return r.data;};
 const schedule=(await json("https://api.jolpi.ca/ergast/f1/2026.json?limit=100")).MRData.RaceTable.Races;
 const stored=check(await sb.from("f1_result_snapshots").select("round").eq("season",2026).eq("validated",true));
 const have=new Set(stored.map((x:any)=>x.round));
 const missing=schedule.filter((x:any)=>!have.has(+x.round)&&Date.parse(x.date+"T"+(x.time||"00:00:00Z"))+3*3600000<Date.now()).slice(0,2);
 const imported=[];
 if(missing.length){
 const sessions=await json("https://api.openf1.org/v1/sessions?year=2026");
 for(const ev of missing){
 const race=sessions.find((x:any)=>x.session_name==="Race"&&!x.is_cancelled&&x.date_start.slice(0,10)===ev.date);
 if(!race||Date.parse(race.date_end)>Date.now())continue;
 const ss=sessions.filter((x:any)=>x.meeting_key===race.meeting_key);
 const q=ss.find((x:any)=>x.session_name==="Qualifying"),sp=ss.find((x:any)=>x.session_name==="Sprint");
 if(!q||(ev.Sprint&&!sp))continue;
 const rr=await json("https://api.openf1.org/v1/session_result?session_key="+race.session_key);
 const qq=await json("https://api.openf1.org/v1/session_result?session_key="+q.session_key);
 const sr=sp?await json("https://api.openf1.org/v1/session_result?session_key="+sp.session_key):[];
 const dd=await json("https://api.openf1.org/v1/drivers?session_key="+race.session_key);
 if(rr.length<20||qq.length<19||(ev.Sprint&&sr.length<20))continue;
 const dm=new Map(dd.map((d:any)=>[String(d.driver_number),d]));
 const map=(a:any[])=>{let fallback=Math.max(0,...a.map(x=>+x.position||0));return a.map(x=>{const d:any=dm.get(String(x.driver_number))||{};return {position:+x.position||++fallback,number:String(x.driver_number),name:d.full_name||d.broadcast_name||("Car "+x.driver_number),team:d.team_name||"",status:x.dsq?"Disqualified":x.dns?"DNS":x.dnf?"Retired":"Finished"};}).sort((a,b)=>a.position-b.position);};
 check(await sb.from("f1_result_snapshots").upsert({season:2026,round:+ev.round,race_name:ev.raceName,race_date:ev.date,circuit:ev.Circuit.circuitName,race_results:map(rr),qualifying_results:map(qq),sprint_results:map(sr),source:"OpenF1 complete race qualifying and sprint",source_event_id:String(race.meeting_key),validated:true,updated_at:new Date().toISOString()},{onConflict:"season,round"}));imported.push(+ev.round);
 }
 }
 const settled=check(await sb.rpc("settle_f1"));
 const api=await json("https://marbles-three.vercel.app/api/f1");
 if(api.marketReady&&api.nextEvent&&api.lockAt&&api.drivers?.length){
 const active=new Set((api.latestResult?.results||[]).map((x:any)=>String(x.number)));
 const prices=Object.fromEntries(api.drivers.filter((x:any)=>active.has(String(x.number))).map((x:any)=>[String(x.number),{name:x.name,multiplier:x.multiplier}]));
 check(await sb.from("fantasy_markets").upsert({competition_code:"F1",season:2026,round:api.targetRound,name:api.nextEvent.name,lock_at:api.lockAt,status:api.marketOpen?"open":"locked",multipliers:prices},{onConflict:"competition_code,season,round"}));
 }
 return Response.json({ok:true,imported,settled,targetRound:api.targetRound});
 }catch(e){console.error(String(e));return Response.json({error:String(e)},{status:500});}
});