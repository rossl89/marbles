// MARBLES F1 live pricing API — Scoring Engine 1.0
// Uses completed 2026 race + qualifying classifications only. Current weekend sessions are excluded.
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:.5;
const sd=a=>{if(!a.length)return 0;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))};
const perf=(p,n)=>n<=1?.5:1-(p-1)/(n-1);
const finished=s=>/^(Finished|\+\d+ Lap|\+\d+ Laps)$/i.test(s||"");
function price(rh,qh,prev){
  let season=.5,recent=.5,qual=.5,rating=.5;
  if(rh.length){season=mean(rh);recent=mean(rh.slice(-3));qual=qh.length?mean(qh.slice(-3)):.5;rating=.4*season+.4*recent+.2*qual}
  const evidence=Math.min(rh.length/6,1), consistency=Math.max(0,1-2*sd(rh));
  const confidence=.6*evidence+.4*consistency, raw=2-rating, target=1.5+(raw-1.5)*confidence;
  const final=prev==null?1.5:Math.max(1,Math.min(2,Math.max(prev-.15,Math.min(prev+.15,target))));
  return {season,recent,qual,rating,confidence,raw,final};
}
async function j(path){const r=await fetch("https://api.jolpi.ca/ergast/f1/"+path);if(!r.ok)throw new Error("Jolpica legacy "+r.status);return r.json()}
async function alpha(path){const r=await fetch("https://api.jolpi.ca/f1/alpha/"+path);if(!r.ok)throw new Error("Jolpica alpha "+r.status);return r.json()}
const get=(o,...keys)=>{for(const k of keys){if(o&&o[k]!=null)return o[k]}};
function normalizeAlphaResult(x){
  const d=get(x,"driver","Driver")||{}, t=get(x,"team","constructor","Constructor")||{};
  const given=get(d,"given_name","givenName","first_name")||"", family=get(d,"family_name","familyName","last_name")||"";
  return {position:+get(x,"position","classified_position","rank")||0,number:String(get(x,"car_number","number")||get(d,"number")||""),name:(given+" "+family).trim()||get(d,"name","full_name")||get(x,"driver_name")||"",team:get(t,"name")||get(x,"team_name","constructor_name")||"",status:get(x,"status","classification")||""};
}
function alphaPayload(a,round){
  const root=a?.MRData||a;
  const sessions=root?.results||root?.Results||root?.data||root?.items||root?.session_results||[];
  const arr=Array.isArray(sessions)?sessions:(sessions?.results||sessions?.data||[]);
  // /results/{round}/ returns the available result sets. Pick the race classification,
  // rather than guessing a session_filter value.
  const raceSet=arr.find(s=>/^(race|r)$/i.test(String(get(s,"session","session_code","type","name")||"")))||arr.find(s=>/race/i.test(String(get(s,"session","session_code","type","name")||"")))||null;
  const rows=raceSet?(get(raceSet,"results","classification","data","items")||[]):arr;
  const meta=(raceSet&&get(raceSet,"round","race","event"))||root?.round||root?.Round||root?.race||root?.event||{};
  const list=Array.isArray(rows)?rows:(rows?.results||rows?.data||[]);
  return {round:+get(meta,"round","round_number")||round,raceName:get(meta,"race_name","name")||"Bahrain Grand Prix in Malaysia",circuit:get(meta?.circuit||{},"name","circuit_name")||get(meta,"circuit_name")||"Sepang International Circuit",date:get(meta,"date","start_date")||"2026-10-04",results:list.map(normalizeAlphaResult).filter(x=>x.name)};
}
module.exports=async function handler(req,res){
  try{
    const [rr,qq,schedulePayload]=await Promise.all([j("2026/results.json?limit=2000"),j("2026/qualifying.json?limit=2000"),alpha("schedules/2026/")]);
    const allRaces=rr.MRData.RaceTable.Races.sort((a,b)=>+a.round-+b.round);

    // Alpha is the authoritative current-season results source; legacy remains history fallback.
    const alphaRounds=await Promise.all(Array.from({length:24},(_,i)=>i+1).map(async round=>{
      try{
        const payload=await alpha("results/"+round+"/R/");
        const parsed=alphaPayload(payload,round);
        return parsed.results.length?parsed:null;
      }catch{return null}
    }));
    for(const ar of alphaRounds.filter(Boolean)){
      const race={round:String(ar.round),raceName:ar.raceName,date:ar.date,Circuit:{circuitName:ar.circuit},Results:ar.results.map(x=>({position:String(x.position),number:x.number,status:x.status,Driver:{driverId:x.name.toLowerCase().replace(/[^a-z0-9]+/g,"-"),givenName:x.name.split(" ").slice(0,-1).join(" "),familyName:x.name.split(" ").slice(-1)[0]},Constructor:{name:x.team}}))};
      const ix=allRaces.findIndex(r=>+r.round===+ar.round);
      if(ix>=0) allRaces[ix]=race; else allRaces.push(race);
    }
    allRaces.sort((a,b)=>+a.round-+b.round);
    // Never consume a partially completed weekend. Advance only when an official race classification exists.
    const completedRounds=allRaces.map(r=>+r.round);
    const throughRound=completedRounds.length?Math.max(...completedRounds):0;
    const targetRound=throughRound+1;
    const races=allRaces.filter(r=>+r.round<=throughRound);
    const quals=new Map(qq.MRData.RaceTable.Races.filter(r=>+r.round<=throughRound).map(r=>[+r.round,r.QualifyingResults||[]]));
    const H=new Map(), Q=new Map(), P=new Map(), meta=new Map();
    for(const race of races){
      const n=race.Results.length, q=quals.get(+race.round)||[], qn=q.length;
      // Price the event using history available BEFORE this race, then update histories after it.
      for(const x of race.Results){
        const id=x.Driver.driverId, rh=H.get(id)||[], qh=Q.get(id)||[];
        const p=price(rh,qh,P.has(id)?P.get(id):null); P.set(id,p.final);
        meta.set(id,{id,number:x.number,name:x.Driver.givenName+" "+x.Driver.familyName,team:x.Constructor?.name||"",...p});
      }
      for(const x of race.Results){const id=x.Driver.driverId,h=H.get(id)||[];h.push(finished(x.status)?perf(+x.position,n):.35);H.set(id,h)}
      for(const x of q){const id=x.Driver.driverId,h=Q.get(id)||[];h.push(perf(+x.position,qn));Q.set(id,h)}
    }
    // Calculate the next market only from completed weekends.
    const out=[];
    for(const [id,m] of meta){const p=price(H.get(id)||[],Q.get(id)||[],P.get(id));out.push({...m,...p,multiplier:+p.final.toFixed(3),races:(H.get(id)||[]).length})}
    out.sort((a,b)=>a.multiplier-b.multiplier);
    res.setHeader("Cache-Control","no-store, max-age=0");
    // Server-authoritative lock derived from the next round's first official on-track session.
    // No race-specific dates are hard-coded: each rollover reads the 2026 schedule automatically.
    const schedRoot=schedulePayload?.MRData||schedulePayload;
    const schedRounds=schedRoot?.rounds||schedRoot?.Rounds||schedRoot?.data||schedRoot?.items||schedRoot?.schedule?.rounds||[];
    const nextRound=Array.isArray(schedRounds)?schedRounds.find(x=>+(get(x,"round","round_number")||get(x?.round_info||{},"round","round_number"))===targetRound):null;
    const sessions=nextRound?(get(nextRound,"sessions","Sessions","full_sessions","schedule")||[]):[];
    const sessionList=Array.isArray(sessions)?sessions:Object.values(sessions||{});
    const sessionTimes=sessionList.map(s=>({
      name:String(get(s,"name","session_name","type","code","session_code")||"Session"),
      ts:Date.parse(get(s,"start_time","start","datetime","date_time","utc_start")||"")
    })).filter(s=>Number.isFinite(s.ts)).sort((a,b)=>a.ts-b.ts);
    const firstSession=sessionTimes[0]||null;
    const lockAt=firstSession?firstSession.ts:null;
    const now=Date.now();
    const marketReady=throughRound>0 && !!nextRound && !!lockAt;
    const marketOpen=marketReady && now<lockAt;
    const latestRace=allRaces.length?allRaces[allRaces.length-1]:null;
    const latestResult=latestRace?{
      round:+latestRace.round,
      raceName:latestRace.raceName,
      circuit:latestRace.Circuit?.circuitName||"",
      date:latestRace.date,
      results:(latestRace.Results||[]).map(x=>({
        position:+x.position,
        number:String(x.number),
        name:x.Driver.givenName+" "+x.Driver.familyName,
        team:x.Constructor?.name||"",
        status:x.status||""
      }))
    }:null;
    res.status(200).json({engine:"1.0",season:2026,throughRound,targetRound,marketReady,marketOpen,serverNow:new Date(now).toISOString(),lockAt:lockAt?new Date(lockAt).toISOString():null,nextEvent:nextRound?{round:targetRound,name:get(nextRound,"name","race_name","event_name")||get(nextRound?.round_info||{},"name","race_name","event_name")||("Round "+targetRound),firstSession:firstSession?.name||null}:null,leakageGuard:"Only completed race weekends are consumed; partial current-weekend sessions are excluded",latestResult,drivers:out});
  }catch(e){res.status(500).json({error:e.message})}
}