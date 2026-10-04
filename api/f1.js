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
async function j(path){const r=await fetch("https://api.jolpi.ca/ergast/f1/"+path);if(!r.ok)throw new Error("Jolpica "+r.status);return r.json()}
module.exports=async function handler(req,res){
  try{
    const [rr,qq]=await Promise.all([j("2026/results.json?limit=2000"),j("2026/qualifying.json?limit=2000")]);
    const allRaces=rr.MRData.RaceTable.Races.sort((a,b)=>+a.round-+b.round);
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
    res.setHeader("Cache-Control","s-maxage=1800, stale-while-revalidate=3600");
    // Server-authoritative Singapore lock. Client clocks cannot reopen the market.
    const singaporeLock=Date.parse("2026-10-09T08:30:00Z"); // 16:30 SGT
    const now=Date.now();
    const marketReady=throughRound>=16;
    const marketOpen=marketReady && now<singaporeLock;
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
    res.status(200).json({engine:"1.0",season:2026,throughRound,targetRound,marketReady,marketOpen,serverNow:new Date(now).toISOString(),lockAt:new Date(singaporeLock).toISOString(),leakageGuard:"Only completed race weekends are consumed; partial current-weekend sessions are excluded",latestResult,drivers:out});
  }catch(e){res.status(500).json({error:e.message})}
}