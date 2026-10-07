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
async function j(path){const r=await fetch("https://api.jolpi.ca/ergast/f1/"+path,{headers:{"User-Agent":"MarblesFantasy/0.1"}});if(!r.ok)throw new Error("Jolpica legacy "+r.status);return r.json()}
async function alpha(path){const r=await fetch("https://api.jolpi.ca/f1/alpha/"+path,{headers:{"User-Agent":"MarblesFantasy/0.1"}});if(!r.ok)throw new Error("Jolpica alpha "+r.status);return r.json()}
const get=(o,...keys)=>{for(const k of keys){if(o&&o[k]!=null)return o[k]}};
const canonicalId=(name,number="")=>{
  // F1 car number is stable across our 2026 sources; name formatting is not.
  const num=String(number??"").trim();
  if(num) return "car-"+num;
  const n=String(name||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  return n||"unknown";
};
function normalizeAlphaResult(x){
  const d=get(x,"driver","Driver")||{}, t=get(x,"team","constructor","Constructor")||{};
  const given=get(d,"given_name","givenName","first_name")||"", family=get(d,"family_name","familyName","last_name")||"";
  return {position:+get(x,"position","classified_position","rank")||0,number:String(get(x,"car_number","number")||get(d,"number")||""),name:(given+" "+family).trim()||get(d,"name","full_name")||get(x,"driver_name")||"",team:get(t,"name")||get(x,"team_name","constructor_name")||"",status:get(x,"status","classification")||""};
}
function resultRows(payload){
  let best=[];
  (function walk(v){
    if(!v||typeof v!=="object") return;
    if(Array.isArray(v)){
      if(v.length){
        const score=v.filter(x=>x&&typeof x==="object"&&get(x,"position","classified_position","rank")!=null&&(get(x,"driver","Driver")||get(x,"driver_name"))).length;
        if(score>best.length) best=v;
      }
      v.forEach(walk); return;
    }
    Object.values(v).forEach(walk);
  })(payload);
  return best;
}
function alphaSessionPayload(a,round,type){
  return resultRows(a).map(normalizeAlphaResult).filter(x=>x.name&&x.position>0);
}
function alphaPayload(a,round){
  const rows=resultRows(a);
  const root=a?.MRData||a;
  let meta={};
  (function findMeta(v){
    if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(meta).length) return;
    if(get(v,"race_name","event_name","start_date","date")!=null) meta=v;
    else Object.values(v).forEach(findMeta);
  })(root);
  return {
    round:+get(meta,"round","round_number")||round,
    raceName:get(meta,"race_name","event_name","name")||("Round "+round),
    circuit:get(meta?.circuit||{},"name","circuit_name")||get(meta,"circuit_name")||"",
    date:get(meta,"date","start_date")||"",
    results:rows.map(normalizeAlphaResult).filter(x=>x.name&&x.position>0)
  };
}
async function storedF1(){
  const url=process.env.SUPABASE_URL;
  const key=process.env.SUPABASE_ANON_KEY||process.env.SUPABASE_PUBLISHABLE_KEY;
  const diagnostic={supabaseConfigured:Boolean(url&&key),supabaseStatus:null,supabaseRows:0};
  if(!url||!key) return {rows:[],diagnostic};
  try{
    const r=await fetch(url+"/rest/v1/f1_result_snapshots?season=eq.2026&validated=eq.true&select=*&order=round.asc",{headers:{apikey:key,Authorization:"Bearer "+key,"Accept-Profile":"public","Content-Profile":"public"}});
    diagnostic.supabaseStatus=r.status;
    if(!r.ok){
      let err={};
      try{ err=await r.json(); }catch(_){ err={message:"Non-JSON response from Supabase"}; }
      diagnostic.supabaseErrorCode=err?.code||null;
      diagnostic.supabaseErrorMessage=err?.message||null;
      diagnostic.supabaseErrorHint=err?.hint||null;
      return {rows:[],diagnostic};
    }
    const rows=await r.json();
    diagnostic.supabaseRows=Array.isArray(rows)?rows.length:0;
    return {rows:Array.isArray(rows)?rows:[],diagnostic};
  }catch(e){
    diagnostic.supabaseStatus="FETCH_ERROR";
    return {rows:[],diagnostic};
  }
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

    // Stable historical ingestion: OpenF1 provides free session results from 2023 onward.
    // Jolpica legacy remains the canonical calendar and an early-season fallback only.
    async function of(path){
      const r=await fetch("https://api.openf1.org/v1/"+path,{headers:{"User-Agent":"MarblesFantasy/0.1"}});
      if(!r.ok) throw new Error("OpenF1 "+r.status);
      return r.json();
    }
    const [meetings,sessions,drivers]=await Promise.all([
      of("meetings?year=2026"),
      of("sessions?year=2026"),
      of("drivers?session_key=latest").catch(()=>[])
    ]);
    const driverByNumber=new Map();
    for(const d of drivers||[]) driverByNumber.set(String(d.driver_number),d);
    const meetingByKey=new Map((meetings||[]).map(m=>[m.meeting_key,m]));
    const sessionGroups=new Map();
    for(const s of sessions||[]){
      if(s.is_cancelled) continue;
      const a=sessionGroups.get(s.meeting_key)||[]; a.push(s); sessionGroups.set(s.meeting_key,a);
    }
    const openf1Rounds=[];
    for(const [meetingKey,ss] of sessionGroups){
      const raceSession=ss.find(s=>String(s.session_name).toLowerCase()==="race");
      if(!raceSession) continue;
      const raceRows=await of("session_result?session_key="+raceSession.session_key).catch(()=>[]);
      if(!raceRows?.length) continue;
      const meeting=meetingByKey.get(meetingKey)||{};
      // OpenF1 is authoritative for completed-event identity.  Do not cross-join
      // providers by date: meeting dates and canonical race dates can differ.
      const raceDate=String(raceSession.date_start||"").slice(0,10);
      const meetingName=meeting.meeting_name||meeting.meeting_official_name||meeting.location||"Grand Prix";
      const meetingCircuit=meeting.circuit_short_name||meeting.location||meeting.country_name||"";
      const qSession=ss.filter(s=>String(s.session_type).toLowerCase()==="qualifying"||String(s.session_name).toLowerCase()==="qualifying").sort((a,b)=>Date.parse(b.date_start)-Date.parse(a.date_start))[0];
      const sprintSession=ss.find(s=>String(s.session_name).toLowerCase()==="sprint");
      const [qRows,sRows]=await Promise.all([
        qSession?of("session_result?session_key="+qSession.session_key).catch(()=>[]):[],
        sprintSession?of("session_result?session_key="+sprintSession.session_key).catch(()=>[]):[]
      ]);
      const mk=(row)=>{
        const num=String(row.driver_number);
        const d=driverByNumber.get(num)||{};
        const name=d.full_name||d.broadcast_name||("Car "+num);
        return {position:+row.position||0,number:num,name,team:d.team_name||"",status:row.dsq?"Disqualified":row.dns?"DNS":row.dnf?"Retired":"Finished"};
      };
      const mappedRace=raceRows.map(mk).filter(x=>x.position>0);
      const mappedQ=(qRows||[]).map(mk).filter(x=>x.position>0);
      const mappedS=(sRows||[]).map(mk).filter(x=>x.position>0);
      openf1Rounds.push({date:raceDate,raceName:meetingName,circuit:meetingCircuit,Results:mappedRace,qualifying:mappedQ,sprint:mappedS});

    }
    // Completed OpenF1 races define their own championship sequence.
    openf1Rounds.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
    for(let i=0;i<openf1Rounds.length;i++){
      const x=openf1Rounds[i], round=i+1;
      const race={round:String(round),raceName:x.raceName,date:x.date,Circuit:{circuitName:x.circuit},Results:x.Results.map(y=>({position:String(y.position),number:y.number,status:y.status,Driver:{driverId:canonicalId(y.name,y.number),givenName:y.name.split(" ").slice(0,-1).join(" "),familyName:y.name.split(" ").slice(-1)[0]},Constructor:{name:y.team}})),AlphaQualifying:x.qualifying,AlphaSprint:x.sprint};
      const ix=allRaces.findIndex(r=>+r.round===round);
      if(ix>=0) allRaces[ix]=race; else allRaces.push(race);
    }
    allRaces.sort((a,b)=>+a.round-+b.round);
    const storedLoad=await storedF1();
    const rawStoredRows=storedLoad.rows;
    const supabaseDiagnostic=storedLoad.diagnostic;

    // A validated snapshot owns the classifications, but never the championship identity.
    // Resolve every stored race back onto the canonical 2026 calendar by race date first;
    // only fall back to its legacy round when the date cannot be resolved.
    const scheduleByRound=new Map(scheduleRounds.map(x=>[+x.round,x]));
    const scheduleByDate=new Map(scheduleRounds.filter(x=>x.date).map(x=>[String(x.date).slice(0,10),x]));
    const canonicalStoredRows=rawStoredRows.map(x=>{
      const raceDate=String(x.race_date||"").slice(0,10);
      const calendar=scheduleByDate.get(raceDate)||scheduleByRound.get(+x.round)||null;
      return {...x,
        round:calendar?+calendar.round:+x.round,
        race_name:calendar?.raceName||x.race_name,
        race_date:calendar?.date||x.race_date,
        circuit:calendar?.Circuit?.circuitName||x.circuit||"",
        sprint_results:[]
      };
    }).sort((a,b)=>+a.round-+b.round);

    // Historical snapshots created before the chronology fix can contain valid Sprint
    // classifications attached to the wrong GP row. Preserve the Sprint payloads in their
    // original chronological order, then attach them only to canonical Sprint weekends.
    const storedSprintPayloads=rawStoredRows
      .slice().sort((a,b)=>+a.round-+b.round)
      .map(x=>x.sprint_results||[]).filter(x=>x.length);
    const canonicalSprintRounds=scheduleRounds
      .filter(x=>x.Sprint&&canonicalStoredRows.some(r=>+r.round===+x.round))
      .sort((a,b)=>+a.round-+b.round);
    for(let i=0;i<Math.min(storedSprintPayloads.length,canonicalSprintRounds.length);i++){
      const row=canonicalStoredRows.find(r=>+r.round===+canonicalSprintRounds[i].round);
      if(row) row.sprint_results=storedSprintPayloads[i];
    }
    const storedRows=canonicalStoredRows;

    if(storedRows.length){
      for(const x of storedRows){
        const race={round:String(x.round),raceName:x.race_name,date:x.race_date,Circuit:{circuitName:x.circuit||""},Results:(x.race_results||[]).map(y=>({position:String(y.position),number:String(y.number||""),status:y.status||"Finished",Driver:{driverId:canonicalId(y.name,y.number),givenName:String(y.name||"").split(" ").slice(0,-1).join(" "),familyName:String(y.name||"").split(" ").slice(-1)[0]},Constructor:{name:y.team||""}})),AlphaQualifying:x.qualifying_results||[],AlphaSprint:x.sprint_results||[]};
        const ix=allRaces.findIndex(r=>+r.round===+x.round);
        if(ix>=0) allRaces[ix]=race; else allRaces.push(race);
      }
      allRaces.sort((a,b)=>+a.round-+b.round);
    }
    // Never consume a partially completed weekend. Advance only when an official race classification exists.
    const completedSet=new Set(allRaces.filter(r=>r.Results?.length).map(r=>+r.round));
    let upstreamThroughRound=0;
    while(completedSet.has(upstreamThroughRound+1)) upstreamThroughRound++;
    const storedByRound=new Map(storedRows.map(x=>[+x.round,x]));
    let storedThroughRound=0;
    while(storedByRound.has(storedThroughRound+1)) storedThroughRound++;
    // Validated stored history wins outright when present.
    const throughRound=storedThroughRound||upstreamThroughRound;
    const targetRound=throughRound+1;
    const storedContiguous=storedThroughRound>0;
    const races=(storedContiguous?storedRows.filter(x=>+x.round<=throughRound).map(x=>({round:String(x.round),raceName:x.race_name,date:x.race_date,Circuit:{circuitName:x.circuit||""},Results:(x.race_results||[]).map(y=>({position:String(y.position),number:String(y.number||""),status:y.status||"Finished",Driver:{driverId:canonicalId(y.name,y.number),givenName:String(y.name||"").split(" ").slice(0,-1).join(" "),familyName:String(y.name||"").split(" ").slice(-1)[0]},Constructor:{name:y.team||""}})),AlphaQualifying:x.qualifying_results||[],AlphaSprint:x.sprint_results||[]})):allRaces.filter(r=>+r.round<=throughRound)).sort((a,b)=>+a.round-+b.round);
    const quals=new Map(qq.MRData.RaceTable.Races.filter(r=>+r.round<=throughRound).map(r=>[+r.round,r.QualifyingResults||[]]));
    const H=new Map(), Q=new Map(), S=new Map(), P=new Map(), meta=new Map(), sprintCounts=new Map();
    for(const race of races){
      const n=race.Results.length;
      const legacyQ=quals.get(+race.round)||[];
      const q=(race.AlphaQualifying?.length?race.AlphaQualifying.map(x=>({position:String(x.position),number:x.number,Driver:{driverId:canonicalId(x.name,x.number)}})):legacyQ.map(x=>({...x,Driver:{...x.Driver,driverId:canonicalId(x.Driver.givenName+" "+x.Driver.familyName,x.number)}})));
      const qn=q.length;
      // Price the event using history available BEFORE this race, then update histories after it.
      for(const x of race.Results){
        const id=canonicalId(x.Driver.givenName+" "+x.Driver.familyName,x.number), rh=H.get(id)||[], qh=Q.get(id)||[];
        // H already contains one weighted observation per completed GP weekend.
        const p=price(rh,qh,P.has(id)?P.get(id):null); P.set(id,p.final);
        meta.set(id,{id,number:x.number,name:x.Driver.givenName+" "+x.Driver.familyName,team:x.Constructor?.name||"",...p});
      }
      const sprint=race.AlphaSprint||[], sn=sprint.length;
      const sprintById=new Map(sprint.map(x=>[canonicalId(x.name,x.number),x]));
      // One race-form observation per GP weekend. On Sprint weekends blend the GP and
      // Sprint performances 2:1, so the Sprint carries 50% of a GP's weight without
      // adding evidence or taking an extra recent-form slot.
      for(const x of race.Results){
        const id=canonicalId(x.Driver.givenName+" "+x.Driver.familyName,x.number),h=H.get(id)||[];
        const gp=finished(x.status)?perf(+x.position,n):.35, sx=sprintById.get(id);
        let weekend=gp;
        if(sx){const sp=finished(sx.status)?perf(+sx.position,sn):.35;weekend=(gp+.5*sp)/1.5;(S.get(id)||S.set(id,[]).get(id)).push(sp);sprintCounts.set(id,(sprintCounts.get(id)||0)+1)}
        h.push(weekend);H.set(id,h);
      }
      for(const x of q){const id=(x.Driver.givenName||x.Driver.familyName)?canonicalId((x.Driver.givenName||"")+" "+(x.Driver.familyName||""),x.number):x.Driver.driverId,h=Q.get(id)||[];h.push(perf(+x.position,qn));Q.set(id,h)}
    }
    // Calculate the next market only from completed weekends.
    const out=[];
    for(const [id,m] of meta){const rh=H.get(id)||[];const p=price(rh,Q.get(id)||[],P.get(id));out.push({...m,...p,multiplier:+p.final.toFixed(3),raceHistory:rh.map(x=>+x.toFixed(6)),qualHistory:(Q.get(id)||[]).map(x=>+x.toFixed(6)),sprints:sprintCounts.get(id)||0,races:rh.length,raceObservations:rh.length})}
    out.sort((a,b)=>a.multiplier-b.multiplier);
    res.setHeader("Cache-Control","no-store, max-age=0");
    const latestRace=races.length?races[races.length-1]:null;
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
    res.status(200).json({build:"f1-history-v2",engine:"1.0",season:2026,throughRound,targetRound,storedCount:rawStoredRows.length,storedThroughRound,historyRounds:races.map(r=>+r.round),supabaseDiagnostic,marketReady,marketOpen,serverNow:new Date(now).toISOString(),lockAt:lockAt?new Date(lockAt).toISOString():null,nextEvent:nextRound?{round:targetRound,name:nextRound.raceName||("Round "+targetRound),firstSession:firstSession?.name||null}:null,sourceStatus:{provider:storedRows.length?"Supabase validated snapshots + upstream fallback":"OpenF1 historical session_result",storedValidatedRounds:rawStoredRows.map(x=>x.round),storedCanonicalRounds:storedRows.map(x=>x.round),sprintCanonicalRounds:canonicalSprintRounds.slice(0,storedSprintPayloads.length).map(x=>+x.round),legacyCompleted:rr.MRData.RaceTable.Races.length,openf1Meetings:(meetings||[]).length,openf1Sessions:(sessions||[]).length,openf1CompletedRounds:openf1Rounds.map((_,i)=>i+1),scheduleRounds:scheduleRounds.length,driverMetadata:(drivers||[]).length,completedCalendarRounds:[...completedSet].sort((a,b)=>a-b)},leakageGuard:"Only completed race weekends are consumed; partial current-weekend sessions are excluded",latestResult,drivers:out});
  }catch(e){res.status(500).json({error:e.message})}
}