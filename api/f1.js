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
const canonicalId=(name,number="")=>{
  const n=String(name||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  return n||("car-"+String(number||"unknown"));
};
function normalizeAlphaResult(x){
  const d=get(x,"driver","Driver")||{}, t=get(x,"team","constructor","Constructor")||{};
  const given=get(d,"given_name","givenName","first_name")||"", family=get(d,"family_name","familyName","last_name")||"";
  return {position:+get(x,"position","classified_position","rank")||0,number:String(get(x,"car_number","number")||get(d,"number")||""),name:(given+" "+family).trim()||get(d,"name","full_name")||get(x,"driver_name")||"",team:get(t,"name")||get(x,"team_name","constructor_name")||"",status:get(x,"status","classification")||""};
}
function alphaSessionPayload(a,round,type){
  const root=a?.MRData||a;
  const sessions=root?.results||root?.Results||root?.data||root?.items||root?.session_results||[];
  const arr=Array.isArray(sessions)?sessions:(sessions?.results||sessions?.data||[]);
  const wanted=arr.find(s=>String(get(s,"session","session_code","type","name")||"").toUpperCase()===String(type).toUpperCase())||null;
  const rows=wanted?(get(wanted,"results","classification","data","items")||[]):arr;
  const list=Array.isArray(rows)?rows:(rows?.results||rows?.data||[]);
  return list.map(normalizeAlphaResult).filter(x=>x.name&&x.position>0);
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
    const [rr,qq,seasonSchedule]=await Promise.all([
      j("2026/results.json?limit=2000"),
      j("2026/qualifying.json?limit=2000"),
      j("2026.json?limit=100")
    ]);
    const allRaces=rr.MRData.RaceTable.Races.sort((a,b)=>+a.round-+b.round);
    const scheduleRounds=seasonSchedule?.MRData?.RaceTable?.Races||[];

    // Discover the opaque Alpha round_id from Alpha's schedule response. Its shape has
    // changed during the preview, so recursively collect objects carrying both a round
    // number and a round_* id instead of assuming one fixed envelope.
    let alphaSchedule=null;
    try{ alphaSchedule=await alpha("schedules/2026/") }catch{}
    const foundRoundIds=new Map();
    (function walk(v){
      if(!v||typeof v!=="object") return;
      if(Array.isArray(v)){v.forEach(walk);return}
      const vals=Object.values(v);
      const rid=vals.find(x=>typeof x==="string"&&/^round_[A-Za-z0-9_-]+$/.test(x));
      const rn=+(get(v,"round","round_number","number")||get(v?.round_info||{},"round","round_number","number")||0);
      if(rid&&rn) foundRoundIds.set(rn,rid);
      vals.forEach(walk);
    })(alphaSchedule);

    const alphaRounds=await Promise.all([...foundRoundIds].map(async ([round,id])=>{
      try{
        const [racePayload,qPayload,sPayload]=await Promise.all([
          alpha("results/"+encodeURIComponent(id)+"/R/").catch(()=>null),
          alpha("results/"+encodeURIComponent(id)+"/Q/").catch(()=>null),
          alpha("results/"+encodeURIComponent(id)+"/S/").catch(()=>null)
        ]);
        if(!racePayload) return null;
        const parsed=alphaPayload(racePayload,round);
        parsed.qualifying=qPayload?alphaSessionPayload(qPayload,round,"Q"):[];
        parsed.sprint=sPayload?alphaSessionPayload(sPayload,round,"S"):[];
        return parsed.results.length?parsed:null;
      }catch{return null}
    }));

    // Alpha's round number is the reliable join key to the canonical schedule; its
    // race metadata/date can be incomplete. Never require Alpha metadata to match.
    for(const ar of alphaRounds.filter(Boolean)){
      const calendar=scheduleRounds.find(r=>+r.round===+ar.round);
      if(!calendar) continue;
      const canonicalRound=+calendar.round;
      const race={round:String(canonicalRound),raceName:calendar.raceName||ar.raceName,date:calendar.date||ar.date,Circuit:{circuitName:calendar.Circuit?.circuitName||ar.circuit},Results:ar.results.map(x=>({position:String(x.position),number:x.number,status:x.status,Driver:{driverId:canonicalId(x.name,x.number),givenName:x.name.split(" ").slice(0,-1).join(" "),familyName:x.name.split(" ").slice(-1)[0]},Constructor:{name:x.team}})),AlphaQualifying:ar.qualifying||[],AlphaSprint:ar.sprint||[]};
      const ix=allRaces.findIndex(r=>+r.round===canonicalRound);
      if(ix>=0) allRaces[ix]=race; else allRaces.push(race);
    }
    allRaces.sort((a,b)=>+a.round-+b.round);
    // Never consume a partially completed weekend. Advance only when an official race classification exists.
    const completedSet=new Set(allRaces.filter(r=>r.Results?.length).map(r=>+r.round));
    let throughRound=0;
    while(completedSet.has(throughRound+1)) throughRound++;
    const targetRound=throughRound+1;
    const races=allRaces.filter(r=>+r.round<=throughRound);
    const quals=new Map(qq.MRData.RaceTable.Races.filter(r=>+r.round<=throughRound).map(r=>[+r.round,r.QualifyingResults||[]]));
    const H=new Map(), Q=new Map(), P=new Map(), meta=new Map(), sprintCounts=new Map();
    for(const race of races){
      const n=race.Results.length;
      const legacyQ=quals.get(+race.round)||[];
      const q=(race.AlphaQualifying?.length?race.AlphaQualifying.map(x=>({position:String(x.position),number:x.number,Driver:{driverId:canonicalId(x.name,x.number)}})):legacyQ.map(x=>({...x,Driver:{...x.Driver,driverId:canonicalId(x.Driver.givenName+" "+x.Driver.familyName,x.number)}})));
      const qn=q.length;
      // Price the event using history available BEFORE this race, then update histories after it.
      for(const x of race.Results){
        const id=canonicalId(x.Driver.givenName+" "+x.Driver.familyName,x.number), rh=H.get(id)||[], qh=Q.get(id)||[];
        const p=price(rh,qh,P.has(id)?P.get(id):null); P.set(id,p.final);
        meta.set(id,{id,number:x.number,name:x.Driver.givenName+" "+x.Driver.familyName,team:x.Constructor?.name||"",...p});
      }
      for(const x of race.Results){const id=canonicalId(x.Driver.givenName+" "+x.Driver.familyName,x.number),h=H.get(id)||[];h.push(finished(x.status)?perf(+x.position,n):.35);H.set(id,h)}
      // Sprint is a half-weight race-form observation: blend 50% sprint performance with
      // 50% neutral (0.5), so it contributes without counting like a full Grand Prix.
      const sprint=race.AlphaSprint||[], sn=sprint.length;
      for(const x of sprint){const id=canonicalId(x.name,x.number),h=H.get(id)||[];const sp=finished(x.status)?perf(+x.position,sn):.35;h.push(.5+.5*(sp-.5));H.set(id,h);sprintCounts.set(id,(sprintCounts.get(id)||0)+1)}
      for(const x of q){const id=(x.Driver.givenName||x.Driver.familyName)?canonicalId((x.Driver.givenName||"")+" "+(x.Driver.familyName||""),x.number):x.Driver.driverId,h=Q.get(id)||[];h.push(perf(+x.position,qn));Q.set(id,h)}
    }
    // Calculate the next market only from completed weekends.
    const out=[];
    for(const [id,m] of meta){const p=price(H.get(id)||[],Q.get(id)||[],P.get(id));out.push({...m,...p,multiplier:+p.final.toFixed(3),raceHistory:(H.get(id)||[]).map(x=>+x.toFixed(6)),qualHistory:(Q.get(id)||[]).map(x=>+x.toFixed(6)),sprints:sprintCounts.get(id)||0,races:(H.get(id)||[]).length})}
    out.sort((a,b)=>a.multiplier-b.multiplier);
    res.setHeader("Cache-Control","no-store, max-age=0");
    const latestRace=allRaces.length?allRaces[allRaces.length-1]:null;
    // Server-authoritative lock derived from the next round's first official on-track session.
    // No race-specific dates are hard-coded: each rollover reads the 2026 schedule automatically.
    // Match the next event chronologically: legacy and Alpha round numbering can differ.
    const latestCompletedDate=latestRace?.date?Date.parse(latestRace.date+"T23:59:59Z"):NaN;
    const nextRound=scheduleRounds
      .filter(x=>Number.isFinite(Date.parse((x.date||"")+"T"+(x.time||"00:00:00Z"))))
      .sort((a,b)=>Date.parse((a.date||"")+"T"+(a.time||"00:00:00Z"))-Date.parse((b.date||"")+"T"+(b.time||"00:00:00Z")))
      .find(x=>!Number.isFinite(latestCompletedDate)||Date.parse((x.date||"")+"T"+(x.time||"00:00:00Z"))>latestCompletedDate)||null;
    const namedSessions=nextRound?[
      ["Practice 1",nextRound.FirstPractice],["Practice 2",nextRound.SecondPractice],["Practice 3",nextRound.ThirdPractice],
      ["Sprint Shootout",nextRound.SprintShootout],["Sprint Qualifying",nextRound.SprintQualifying],["Sprint",nextRound.Sprint],
      ["Qualifying",nextRound.Qualifying],["Race",{date:nextRound.date,time:nextRound.time}]
    ].filter(([,s])=>s):[];
    const sessionTimes=namedSessions.map(([name,s])=>({
      name,
      ts:Date.parse(String(s.date||"")+"T"+String(s.time||"00:00:00Z"))
    })).filter(s=>Number.isFinite(s.ts)).sort((a,b)=>a.ts-b.ts);
    const firstSession=sessionTimes[0]||null;
    const lockAt=firstSession?firstSession.ts:null;
    const now=Date.now();
    const marketReady=throughRound>0 && !!nextRound && !!lockAt;
    const marketOpen=marketReady && now<lockAt;

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
    res.status(200).json({engine:"1.0",season:2026,throughRound,targetRound,marketReady,marketOpen,serverNow:new Date(now).toISOString(),lockAt:lockAt?new Date(lockAt).toISOString():null,nextEvent:nextRound?{round:targetRound,name:nextRound.raceName||("Round "+targetRound),firstSession:firstSession?.name||null}:null,sourceStatus:{legacyCompleted:rr.MRData.RaceTable.Races.length,alphaRoundIds:foundRoundIds.size,alphaCompleted:alphaRounds.filter(Boolean).length,alphaParsedRounds:alphaRounds.filter(Boolean).map(x=>x.round).sort((a,b)=>a-b),scheduleRounds:scheduleRounds.length,completedCalendarRounds:[...completedSet].sort((a,b)=>a-b)},leakageGuard:"Only completed race weekends are consumed; partial current-weekend sessions are excluded",latestResult,drivers:out});
  }catch(e){res.status(500).json({error:e.message})}
}