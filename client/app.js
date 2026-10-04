// Shared client logic: auth, dashboard, plan wizard, injury map, connect, devices
const $=s=>document.querySelector(s);
let TOKEN=localStorage.getItem("af_token"),reg=false;

// ---- helpers ----
// HTML-escape any text that came from a user or the server before it goes into innerHTML (XSS protection)
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num=(id)=>{const el=$("#"+id);return el&&el.value.trim()!==""?Number(el.value):NaN};

window.api=async(u,m="GET",b)=>{
  const r=await fetch(u,{method:m,headers:{"Content-Type":"application/json",...(TOKEN?{Authorization:"Bearer "+TOKEN}:{})},body:b?JSON.stringify(b):undefined});
  let j={};try{j=await r.json()}catch{}
  if(r.status===401&&TOKEN)window.logout();
  if(!r.ok)throw new Error(j.error||"Request failed ("+r.status+")");
  return j;
};

window.flip=()=>{reg=!reg;$("#nm").style.display=reg?"block":"none";$("#atit").textContent=reg?"Create your account":"Login to AegisFit";$("#aflip").textContent=reg?"Have an account? Login":"Create an account";$("#aerr").textContent=""};
let VERIFIED=true;
window.doAuth=async()=>{
  try{
    const j=await api("/api/auth/"+(reg?"register":"login"),"POST",{name:$("#nm").value.trim(),email:$("#em").value.trim(),password:$("#pw").value});
    TOKEN=j.token;localStorage.setItem("af_token",TOKEN);VERIFIED=!!j.verified;
    $("#pw").value="";
    if(reg&&!j.verified){
      $("#aerr").style.color="var(--g)";
      $("#aerr").textContent="Account created. (Demo mode: no real email is sent — verification code shown here) → "+j.devVerifyCode;
      setTimeout(()=>{
        const c=prompt("Enter the 6-digit verification code shown above:");
        if(c)api("/api/auth/verify","POST",{code:c.trim()}).then(()=>{VERIFIED=true;boot()}).catch(e=>{alert(e.message);boot()});
        else boot();
      },300);
      return;
    }
    boot();
  }catch(e){$("#aerr").style.color="var(--rd)";$("#aerr").textContent=e.message}
};
window.logout=()=>{
  TOKEN=null;localStorage.removeItem("af_token");
  for(const k of [1,2,3,4,5,6,7])$("#p"+k).classList.add("hidden");
  $("#pa").classList.remove("hidden");
};
function boot(){$("#pa").classList.add("hidden");tab(3)}

// Main navigation controller. The HTML buttons call tab(n), so it must be exposed globally.
window.tab=n=>{
  for(const k of [1,2,3,4,5,6,7])$("#p"+k).classList.add("hidden");
  for(const k of [1,2,3,4,5,6,7])$("#t"+k)?.classList.remove("on");
  $("#p"+n)?.classList.remove("hidden");
  $("#t"+n)?.classList.add("on");
  if(typeof window.onTab==="function")window.onTab(n);
};
const COL={TRAIN:["#34d39922","#34d399"],MODIFY:["#f59e0b22","#f59e0b"],POSTPONE:["#fb923c22","#fb923c"],RECOVERY:["#f43f5e22","#f43f5e"]};
const B=c=>{const k=COL[c]||["#161b24","#8a96a8"];return `background:${k[0]};color:${k[1]};border:1px solid currentColor`};
const inp=(id,l,v)=>`<label class="mu" style="font-size:12px">${l}<input class="in" id="${id}" type="number" value="${v}" style="width:100%;margin-top:4px"></label>`;
const fail=(e)=>alert(e&&e.message?e.message:String(e));
window.onTab=n=>{
  const run=p=>p.catch(e=>{const s=$("#p"+n);if(s&&!TOKEN)return;console.error(e)});
  if(n===3)run(dash());if(n===4)run(planTab());if(n===5)run(injTab());if(n===6)connectTab();if(n===7)run(devTab());
};

// ---- Dashboard ----
async function dash(){
  const d=await api("/api/dashboard"),w=d.acwr,c=d.checkin||{sleep:"–",sore:"–",pain:"–",ready:"–"};
  const maxLoad=Math.max(1,...d.heatmap.map(h=>h.load));
  const heat=d.heatmap.map(h=>{const v=h.load/maxLoad,col=h.load===0?"#161b24":v>.66?"#34d399":v>.33?"#1f8f68":"#0d4a35";return `<div title="${Math.round(h.load)} AU" style="width:100%;aspect-ratio:1;border-radius:3px;background:${col}"></div>`}).join("");
  const rt=d.readinessTrend.filter(t=>Number.isFinite(+t.ready));
  const trendMax=Math.max(1,...rt.map(t=>+t.ready)),pts=rt.map((t,i)=>`${i/(Math.max(1,rt.length-1))*100},${100-(t.ready/trendMax*90)}`).join(" ");
  const P=d.perf,pl=d.plan,hc=d.healthConnect,rdy=Number.isFinite(+c.ready)?+c.ready:null,slp=Number.isFinite(+c.sleep)?+c.sleep:null,sor=Number.isFinite(+c.sore)?+c.sore:null;
  const GL={hypertrophy:"Muscle &amp; Weight Gain",strength:"Strength",endurance:"Endurance",fatloss:"Fat Loss"},DL={veg:"Pure Vegetarian",nonveg:"Non-Vegetarian",egg:"Eggetarian",vegan:"Vegan"},BL={OPTIMAL:"Normal monitoring range",BUILDING:"Baseline building",LOW:"Low load",ELEVATED:"Elevated load",HIGH:"High load spike"};
  const top=d.injuries.slice().sort((a,b)=>b.sev-a.sev)[0],dk=top?[["pain","Pain"],["sore","Soreness"],["stiff","Stiffness"],["tend","Tenderness"]].sort((a,b)=>(+top[b[0]]||0)-(+top[a[0]]||0))[0]:null;
  const imp=d.impact.some(x=>x.level==="HIGH")?["High","#f43f5e"]:d.impact.some(x=>x.level==="MODERATE")?["Moderate","#fb923c"]:["Minimal","#facc15"];
  const rest=slp==null?["No data","var(--mu)"]:slp>=7&&(sor==null||sor<=3)?["Well Rested","var(--g)"]:slp>=6?["Recovering","#facc15"]:["Fatigued","#f43f5e"];
  const ps=(l,v,col)=>`<div class="ps"><div class="lb">${l}</div><div style="font:800 ${col?"30":"24"}px inherit;margin-top:8px;color:${col||"var(--tx)"}">${v}</div></div>`;
  $("#p3").innerHTML=`${d.verified===false?`<div class="card" style="border-color:#f59e0b;background:#f59e0b12;display:flex;justify-content:space-between;align-items:center;gap:10px"><span>⚠ Email not verified yet (demo mode — no real email sent).</span><button class="btn" style="background:#f59e0b;color:#1a1200" onclick="resendVerify()">Verify now</button></div>`:""}
<div class="card hero"><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px"><span class="chip">● CONNECTED ATHLETE ENGINE</span><span class="chip d">Connected Devices: <b style="color:var(--g)">${+d.devices||0}</b></span></div>
<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap"><div style="max-width:560px"><h1 style="margin:0;font-size:38px">Hello, <span style="color:var(--g)">${esc(d.name)}</span> 👋</h1><div class="mu" style="margin-top:8px">Integrated sports-performance engine continuously collecting and adapting to your training, ACWR workload ratio, wearable metrics, and recovery logs.</div></div>
<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="hb g" onclick="tab(4)">Diet Plan</button><button class="hb t" onclick="goTo('logCard')">Log ACWR Workload</button><button class="hb" onclick="goTo('ciCard')">Start Check-In</button></div></div></div>
<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">${pl?`<div><span class="chip" style="margin-right:8px">ACTIVE DIET PLAN</span><b style="font-size:13px">${GL[pl.profile.goal]||esc(pl.profile.goal)}</b> <span class="mu" style="font-size:12px">• ${esc(DL[pl.profile.diet]||pl.profile.diet)}</span><div style="margin-top:8px;font-weight:700">Target Intake: <span style="color:var(--g)">${+pl.kcal} kcal</span> | <span style="color:var(--g)">${+pl.protein}g Protein</span></div></div><div style="display:flex;gap:8px"><button class="hb g" onclick="tab(4)">View Diet Plan</button><button class="hb" onclick="tab(4)">Edit</button></div>`:`<div><b>No diet plan yet</b><div class="mu" style="font-size:12px">Generate a personalised calorie &amp; macro plan.</div></div><button class="hb g" onclick="tab(4)">Create Diet Plan</button>`}</div>
<div class="sg"><div class="card sc"><div class="tt"><span>ACWR Workload Ratio</span><span class="bd">AegisFit</span></div><div><span class="sn">${+w.ratio}</span> <span class="bd" style="margin-left:6px">${esc(BL[w.band]||w.band)}</span></div><div class="mu" style="font-size:11px;margin:10px 0 6px;display:flex;justify-content:space-between"><span>Acute (7d Load): ${+w.acute} AU</span><span>Chronic (28d): ${+w.chronic} AU</span></div><div class="bar"><i style="width:${Math.max(0,Math.min(100,w.ratio/1.3*100))}%"></i></div><button class="sb d" onclick="seedBase()">Seed 28-Day Baseline Demo</button></div>
<div class="card sc"><div class="lb">Today's State</div><div class="tt"><span>Readiness Index</span><span class="bd">AegisFit</span></div><div><span class="sn">${rdy==null?"–":rdy}</span> <span class="mu">/ 100</span></div><div class="mu" style="font-size:12px;margin-top:10px">${rdy==null?"No check-in yet":rdy>=70?"Prime Training Readiness":rdy>=40?"Moderate Readiness":"Low Readiness"}</div><button class="sb" onclick="goTo('ciCard')">Start Daily Log</button></div>
<div class="card sc"><div class="lb">Sleep &amp; Fatigue</div><div class="tt"><span>Recovery Status</span><span class="bd n">${hc?"Health Connect":"Unintegrated"}</span></div><div style="font:800 22px inherit;color:${rest[1]}">${rest[0]}</div><div class="mu" style="font-size:12px;margin-top:8px">Sleep: ${slp==null?"–":slp+"h"}${slp==null?"":slp>=7?" (Optimal)":" (Low)"}</div><div class="mu" style="font-size:11px;margin-top:22px">Reported Soreness: <b style="color:var(--tx)">${sor==null?"–":sor+"/10"}</b></div></div>
<div class="card sc"><div class="lb" style="color:#f43f5e;display:flex;justify-content:space-between"><span>Reported Discomfort</span><a href="#" style="color:var(--g);text-decoration:none" onclick="tab(5);return false">Assessment →</a></div><div class="tt"><span>Anatomy Profile</span></div><div><span class="sn" style="font-size:26px">${d.injuries.length}</span> <span class="mu" style="font-size:12px">reported areas</span></div>${top?`<div style="font-size:11px;margin-top:8px"><span class="mu">Dominant:</span> <b style="color:var(--g)">${dk[1]} — ${+top[dk[0]]||+top.sev}/10</b></div>`:'<div class="mu" style="font-size:11px;margin-top:8px">No discomfort reported</div>'}<div style="font-size:11px;margin-top:4px"><span class="mu">Training Impact:</span> <b style="color:${imp[1]}">${imp[0]}</b></div><button class="sb d" onclick="tab(5)">View Assessment →</button></div></div>
<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">Athlete Performance Score</h2><span class="mu" style="font-size:12px">${P.ready?"Based on "+(+P.sessions)+" logged sessions":"Building your performance baseline (Requires 3+ logged sessions)"}</span></div>
<div class="sg" style="margin-top:14px">${ps("Overall Score",P.ready?(+P.score)+' <span class="mu" style="font-size:14px">/ 100</span>':"Baseline Building")}${ps("Consistency (28-day)",(+P.consistency)+"%","var(--g)")}${ps("Movement Quality",P.quality==null?"—":(+P.quality)+"%","#a78bfa")}${ps("Strength Progress",(P.strength>=0?"+":"")+(+P.strength)+"%","#38bdf8")}</div></div>
<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><div class="mu" style="font:11px monospace">TODAY'S DECISION ENGINE</div>${esc(d.reason)}</div><b style="padding:8px 18px;border-radius:99px;${B(d.recommendation)}">${esc(d.recommendation)}</b></div>
<div class="two" style="grid-template-columns:1fr 1fr"><div class="card" id="ciCard"><b>Daily check-in</b><div class="grid" style="margin:10px 0">${inp("ci_s","Sleep (h)",7)}${inp("ci_o","Soreness 0-10",2)}${inp("ci_p","Pain 0-10",0)}${inp("ci_r","Readiness 0-100",70)}</div><button class="btn" onclick="sendCI()">Save check-in</button></div>
<div class="card" id="logCard"><b>Log a workout</b><div class="grid" style="margin:10px 0">${inp("lg_m","Minutes",45)}${inp("lg_r","RPE 1-10",7)}</div><button class="btn" onclick="sendLog()">Save workout</button><p class="mu" style="font-size:12px">Load = minutes × RPE. ACWR = 7-day ÷ 28-day average.</p></div></div>
<div class="two" style="grid-template-columns:1fr 1fr"><div class="card"><b>28-day consistency</b><div style="display:grid;grid-template-columns:repeat(14,1fr);gap:4px;margin-top:10px">${heat}</div><p class="mu" style="font-size:11px;margin-top:8px">Darker = less load that day, bright green = highest.</p></div>
<div class="card"><b>Readiness trend</b>${rt.length>1?`<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:110px;margin-top:8px"><polyline points="${pts}" fill="none" stroke="#34d399" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`:'<p class="mu" style="margin-top:10px">Log at least two daily check-ins to see your trend.</p>'}</div></div>
<div class="card row" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><b>Wearable sync</b><div class="mu" style="font-size:12px">Pulls demo Strava activities idempotently — re-syncing never duplicates workouts.</div></div><button class="btn" onclick="wearSync()">⟳ Sync Strava (demo)</button></div>
<div class="card"><b>Recent AI Vision sessions</b>${d.sessions.map(s=>`<div class="r"><b>${esc(s.exercise)}</b><span class="mu">${esc(new Date(s.t).toLocaleString())}</span><span class="p">${+s.reps} reps · ${+s.quality}%</span></div>`).join("")||'<p class="mu">None yet — use AI Form Check and press Save session.</p>'}</div>
${d.cart&&d.cart.length?`<div class="card"><b>Cart (${d.cart.length})</b>${d.cart.map(c=>`<div class="r"><b>${esc(c.name)}</b><span class="mu">${esc(c.source)}</span><span class="p">₹${esc(c.price)}<br><button class="btn cartdel" data-id="${esc(c.id)}" style="background:#1a202b;padding:3px 9px;font-size:11px;margin-top:4px">Remove</button></span></div>`).join("")}</div>`:""}`;
}
// event delegation for cart removal (no inline JS with user data)
$("#p3").addEventListener("click",async e=>{
  const b=e.target.closest(".cartdel");if(!b)return;
  try{await api("/api/cart/"+encodeURIComponent(b.dataset.id),"DELETE");dash()}catch(err){fail(err)}
});
window.goTo=id=>document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"center"});
window.seedBase=async()=>{try{await api("/api/seed","POST",{});dash()}catch(e){fail(e)}};
window.sendCI=async()=>{
  const sleep=num("ci_s"),sore=num("ci_o"),pain=num("ci_p"),ready=num("ci_r");
  if(![sleep,sore,pain,ready].every(Number.isFinite))return alert("Please fill in all four check-in values.");
  if(sleep<0||sleep>24)return alert("Sleep must be between 0 and 24 hours.");
  if(sore<0||sore>10||pain<0||pain>10)return alert("Soreness and pain must be between 0 and 10.");
  if(ready<0||ready>100)return alert("Readiness must be between 0 and 100.");
  try{await api("/api/checkin","POST",{sleep,sore,pain,ready});dash()}catch(e){fail(e)}
};
window.sendLog=async()=>{
  const min=num("lg_m"),rpe=num("lg_r");
  if(!(min>0&&min<=600))return alert("Minutes must be between 1 and 600.");
  if(!(rpe>=1&&rpe<=10))return alert("RPE must be between 1 and 10.");
  try{await api("/api/logs","POST",{min,rpe});dash()}catch(e){fail(e)}
};
window.wearSync=async()=>{try{const j=await api("/api/wearable/sync","POST",{provider:"strava"});alert(`Imported ${j.imported} new, skipped ${j.skipped} already-synced activities.`);dash()}catch(e){fail(e)}};
window.resendVerify=async()=>{const c=prompt("Demo mode — check the code shown at signup, or re-register to get a new one. Enter code:");if(c)try{await api("/api/auth/verify","POST",{code:c.trim()});dash()}catch(e){fail(e)}};

// ---- AI Plan ----
async function planTab(){
  const p=await api("/api/plan");
  $("#p4").innerHTML=`<div class="card"><h2 style="margin-top:0">AI Plan Wizard</h2><div class="grid">${inp("pa_a","Age",21)}${inp("pa_h","Height (cm)",172)}${inp("pa_w","Weight (kg)",65)}
${[["pa_g","Gender",["male","female"]],["pa_go","Goal",["hypertrophy","strength","endurance","fatloss"]],["pa_ac","Activity",["sedentary","light","moderate","active","athlete"]],["pa_d","Diet",["veg","nonveg","egg","vegan"]]].map(([i,l,o])=>`<label class="mu" style="font-size:12px">${l}<select class="in" id="${i}" style="width:100%;margin-top:4px">${o.map(x=>`<option ${i==="pa_ac"&&x==="moderate"?"selected":""}>${x}</option>`).join("")}</select></label>`).join("")}</div><button class="btn" style="margin-top:12px" onclick="genPlan()">Generate plan</button><span id="perr" class="mu"></span></div><div id="planout">${p?showPlan(p):""}</div>`;
  // pre-fill the wizard from the saved plan so editing doesn't start from defaults
  if(p&&p.profile){const f=p.profile;const set=(id,v)=>{const el=$("#"+id);if(el&&v!=null)el.value=v};
    set("pa_a",f.age);set("pa_h",f.height);set("pa_w",f.weight);set("pa_g",f.gender);set("pa_go",f.goal);set("pa_ac",f.activity);set("pa_d",f.diet)}
}
window.genPlan=async()=>{
  const age=num("pa_a"),height=num("pa_h"),weight=num("pa_w");
  $("#perr").textContent="";
  if(!(age>10&&age<100&&height>100&&height<250&&weight>25&&weight<300)){$("#perr").textContent=" Enter a valid age, height (cm) and weight (kg).";return}
  try{
    const p=await api("/api/plan","POST",{age,height,weight,gender:$("#pa_g").value,goal:$("#pa_go").value,activity:$("#pa_ac").value,diet:$("#pa_d").value});
    $("#planout").innerHTML=showPlan(p);
  }catch(e){$("#perr").textContent=" "+e.message}
};
const showPlan=p=>`<div class="grid"><div class="card"><b>Target</b><div class="big">${+p.kcal}</div><span class="mu">kcal/day · BMR ${+p.bmr} · TDEE ${+p.tdee}</span></div><div class="card"><b>Macros</b><div class="mu" style="margin-top:8px">Protein <b style="color:var(--g)">${+p.protein}g</b> · Carbs <b>${+p.carbs}g</b> · Fat <b>${+p.fat}g</b></div><p class="mu" style="font-size:12px">${esc(p.micro)}</p></div></div>
<div class="two" style="grid-template-columns:1fr 1fr"><div class="card"><b>Indian meal plan</b>${p.meals.map(m=>`<div class="r"><div><b>${esc(m.meal)}</b><div class="mu">${esc(m.food)}</div></div><span class="p">${+m.kcal} kcal</span></div>`).join("")}</div><div class="card"><b>Weekly workouts</b>${p.workouts.map(w=>`<div class="r"><b>${esc(w.day)}</b><span class="mu">${esc(w.work)}</span></div>`).join("")}</div></div>`;

// ---- Connect (local clubs) ----
const CLUBS=[["Vadodara Restorative Yoga & Mobility Circle","Yoga","Community Group","1.1"],["Vadodara Striders & Distance Runners","Running","Official Partner","1.2"],["Vadodara Athlete Mobility Lab","Strength","Official Partner","1.4"],["Sayaji Baug Cycling Club","Cycling","Community Group","2.3"],["Alkapuri Badminton Arena League","Badminton","Official Partner","3.1"],["Vadodara Football Sunday Cup","Football","Event","4.8"]];
const SPORTS=["All","Running","Strength","Cycling","Yoga","Football","Badminton"];
let csport="All";
window.setSport=i=>{csport=SPORTS[i]||"All";connectTab()};
function connectTab(){
  const L=CLUBS.filter(c=>csport==="All"||c[1]===csport);
  $("#p6").innerHTML=`<div class="card" style="background:linear-gradient(135deg,#0e1219,#111c30)"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><span class="tag" style="font:10px monospace;color:var(--g);background:#34d39914;border:1px solid #34d39940;padding:3px 10px;border-radius:99px">◎ AEGISFIT CONNECT</span><h1 style="font-size:26px;margin:10px 0">Train local. Compete together.<br><span style="color:var(--g)">Represent your community.</span></h1><div class="mu" style="max-width:560px">Connect with verified sports clubs, local training groups, and competitive tournaments.</div></div><button class="btn" onclick="alert('Community creation form (demo)')">＋ Create Community / Club</button></div></div>
<div class="mu" style="font:11px monospace;margin:14px 0 8px">FILTER BY SPORTS ACTIVITY</div><div style="display:flex;gap:8px;overflow-x:auto;margin-bottom:16px;padding-bottom:4px">${SPORTS.map((s,i)=>`<button class="pill ${csport===s?"on":""}" style="${csport===s?"background:#10b981;color:#04120c;border:none":""}" onclick="setSport(${i})">${s==="All"?"All Activities":s}</button>`).join("")}</div>
<div class="card" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><span class="mu">📍 Gujarat › <b style="color:var(--g)">Vadodara</b></span><span class="tag" style="font:10px monospace;color:var(--g);background:#34d39914;border:1px solid #34d39940;padding:3px 10px;border-radius:99px">Public grounds &amp; verified venues only</span></div>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(270px,1fr))">${L.map(c=>`<div class="card"><div style="display:flex;justify-content:space-between"><span class="tag" style="font:10px monospace;border:1px solid var(--bd);padding:3px 10px;border-radius:99px;color:var(--mu);background:transparent">GENERAL</span><span class="tag" style="font:10px monospace;color:var(--g);background:#34d39914;border:1px solid #34d39940;padding:3px 10px;border-radius:99px">${c[3]} km away</span></div><b style="display:block;margin:12px 0;font-size:15px">${esc(c[0])}</b><div style="display:flex;justify-content:space-between;align-items:center"><span class="tag" style="font:10px monospace;background:transparent;color:${c[2]==="Official Partner"?"var(--g)":"#a78bfa"};border:1px solid ${c[2]==="Official Partner"?"#34d39960":"#a78bfa60"};padding:3px 10px;border-radius:99px">✓ ${esc(c[2])}</span><button class="btn" style="background:#1a202b" onclick="this.textContent=this.textContent==='Joined ✓'?'Join':'Joined ✓'">Join</button></div></div>`).join("")||'<div class="card mu">No matches for this sport.</div>'}</div>`;
}

// ---- Devices (wearables) ----
const DEVS=[
  ["🏃","Strava","WEARABLE GPS",["RUN","CYCLE","SWIM","WALK","HIKE","STRENGTH"],"Ready to connect"],
  ["❤️","Apple Health","NATIVE ECOSYSTEM",["STEPS","HEART_RATE","SLEEP","WORKOUTS"],"Requires AegisFit native mobile wrapper (iOS/Android)"],
  ["📱","Android Health Connect","NATIVE ECOSYSTEM",["STEPS","HEART_RATE","SLEEP","ACTIVE_CALORIES"],"Android companion app reads Health Connect and securely syncs selected metrics to AegisFit."],
  ["⌚","Garmin Connect","WEARABLE GPS",["RUN","CYCLE","SWIM","STEPS","VO2_MAX"],"Requires backend API credentials (CLIENT_ID & CLIENT_SECRET)"],
  ["⚡","Fitbit","WEARABLE HEALTH",["STEPS","HEART_RATE","SLEEP","ACTIVE_MINUTES"],"Requires backend API credentials (CLIENT_ID & CLIENT_SECRET)"]
];
let devOn={};
async function healthStatus(){try{return await api('/api/healthconnect/status')}catch{return {connected:false}}}
window.generateHealthPair=async()=>{
  try{
    const j=await api('/api/healthconnect/pair','POST',{});
    const box=$('#hcPair');
    if(box){box.innerHTML=`<div style="font-size:30px;font-weight:900;letter-spacing:6px;color:var(--g)">${esc(j.code)}</div><div class="mu" style="margin-top:4px">Valid for 10 minutes. Enter this code in the AegisFit Android app.</div>`;
      const btn=$('#hcPairBtn');if(btn)btn.textContent='Generate New Code'}
  }catch(e){fail(e)}
};
async function devTab(){
  const hs=await healthStatus();
  const hc=hs.connected;
  const hcData=hs.data||{};
  $("#p7").innerHTML=`<div class="card"><span class="tag" style="font:10px monospace;color:var(--g);background:#34d39914;border:1px solid #34d39940;padding:3px 10px;border-radius:99px">● CONNECTED ATHLETE ECOSYSTEM</span><h1 style="font-size:26px;margin:12px 0 6px">Wearable &amp; Health Provider Settings</h1><div class="mu" style="max-width:700px">Android Health Connect is handled by the AegisFit Android companion app. The browser cannot directly read Health Connect data.</div></div>
<div class="card" style="border-color:${hc?'#34d39960':'#a78bfa60'}"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><span class="tag" style="background:${hc?'#34d399':'#a78bfa'}">${hc?'CONNECTED':'ANDROID SETUP'}</span><h2 style="margin:10px 0 5px">📱 Android Health Connect</h2><div class="mu">1. Install the AegisFit Android companion app. 2. Open this page on your PC and generate a pairing code. 3. Enter the code in the Android app. 4. Allow Health Connect permissions.</div></div><button id="hcPairBtn" class="btn" onclick="generateHealthPair()">Generate Pairing Code</button></div>
<div id="hcPair" style="margin-top:14px;padding:14px;border:1px dashed var(--bd);border-radius:12px;background:#080a0f"><span class="mu">No active pairing code. Generate one when the Android app is ready.</span></div>
${hc?`<div class="grid" style="margin-top:14px"><div class="card" style="margin:0"><div class="mu">STEPS</div><div class="big" style="font-size:36px">${+hcData.steps||0}</div></div><div class="card" style="margin:0"><div class="mu">ACTIVE CALORIES</div><div class="big" style="font-size:36px">${+hcData.calories||0}</div></div><div class="card" style="margin:0"><div class="mu">AVG HEART RATE</div><div class="big" style="font-size:36px">${hcData.avgHeartRate!=null?+hcData.avgHeartRate:'–'}</div></div></div><div class="mu" style="margin-top:10px;font-size:12px">Last synced: ${hs.lastSync?esc(new Date(hs.lastSync).toLocaleString()):'—'}</div>`:''}</div>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(290px,1fr))">${DEVS.map(d=>{const on=d[1]==='Android Health Connect'?hc:devOn[d[1]],native=d[1]==='Apple Health',cfg=d[4].includes('backend');return`<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div style="display:flex;gap:10px;align-items:center"><div style="width:42px;height:42px;border:1px solid var(--bd);border-radius:12px;background:#0d1320;display:grid;place-items:center;font-size:19px">${d[0]}</div><div><b style="font-size:15px">${d[1]}</b><div style="color:var(--g);font:10px monospace">${d[2]}</div></div></div><span class="tag" style="font:10px monospace;padding:3px 10px;border-radius:99px;border:1px solid ${on?'#34d39960':native?'#a78bfa60':cfg?'#f59e0b60':'var(--bd)'};color:${on?'var(--g)':native?'#a78bfa':cfg?'#f59e0b':'var(--mu)'};background:transparent">${on?'Connected':native?'Native Mobile Required':cfg?'Requires Config':'Not Connected'}</span></div>
<div style="margin:14px 0;display:flex;gap:6px;flex-wrap:wrap">${d[3].map(t=>`<span style="font:9px monospace;border:1px solid var(--bd);border-radius:6px;padding:3px 8px;color:var(--mu)">${t}</span>`).join('')}</div>
<div style="background:#080a0f;border:1px solid var(--bd);border-radius:10px;padding:10px;font:12px monospace;color:var(--mu)">${d[1]==='Android Health Connect'?(hc?'Real Health Connect data synced':'Use the pairing code above; no fake data is shown.'):on?'Connection state active':d[4]}</div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;border-top:1px solid var(--bd);padding-top:10px"><span class="mu mono" style="font-size:11px">${on?(d[1]==='Android Health Connect'?'Synced from device':'Connected (demo)'):'No data synced'}</span>${d[1]==='Android Health Connect'?`<button class="btn" onclick="generateHealthPair()">${hc?'Re-pair Android':'Connect Android'}</button>`:`<button class="btn" style="${native?'background:#1a202b':''}" onclick="${native?`alert('Apple Health requires a native iOS companion app.')`:cfg?`alert('Requires backend API credentials (not configured in this demo).')`:`toggleDev('${d[1]}')`}">${on?'Disconnect':native?'App Info':'Connect'}</button>`}</div></div>`}).join('')}</div>`;
}
window.toggleDev=n=>{devOn[n]?delete devOn[n]:devOn[n]=1;devTab()};

// ---- 3D injury map (Three.js) ----
// key:[name,group,x,y,z,radius,scale]
// Convention: the figure faces the viewer in "Front" view, so the figure's LEFT side (+x) appears on screen-right.
const REG={head:["Head","Upper Body",0,3.6,0,.5,[.9,1.15,1]],chest:["Chest","Upper Body",0,2.3,0,.7,[1.15,1.35,.75]],lumbar:["Lumbar Spine","Core",0,.95,0,.5,[1.1,1,.8]],
sh_l:["Left Shoulder","Upper Body",.95,2.95,0,.3,[1,1,1]],sh_r:["Right Shoulder","Upper Body",-.95,2.95,0,.3,[1,1,1]],el_l:["Left Elbow","Upper Body",1.3,1.55,0,.22,[1,1,1]],el_r:["Right Elbow","Upper Body",-1.3,1.55,0,.22,[1,1,1]],
wr_l:["Left Wrist","Upper Body",1.5,.4,0,.18,[1,1,1]],wr_r:["Right Wrist","Upper Body",-1.5,.4,0,.18,[1,1,1]],hip_l:["Left Hip","Lower Body",.45,0,0,.32,[1,1,1]],hip_r:["Right Hip","Lower Body",-.45,0,0,.32,[1,1,1]],
knee_l:["Left Knee","Lower Body",.5,-1.8,0,.28,[1,1,1]],knee_r:["Right Knee","Lower Body",-.5,-1.8,0,.28,[1,1,1]],ank_l:["Left Ankle","Lower Body",.5,-3.6,0,.22,[1,1,1]],ank_r:["Right Ankle","Lower Body",-.5,-3.6,0,.22,[1,1,1]]};
const LINKS=[["head","chest",.09],["chest","lumbar",.1],["lumbar","hip_l",.08],["lumbar","hip_r",.08],["sh_l","sh_r",.09],["sh_l","el_l",.1],["el_l","wr_l",.08],["sh_r","el_r",.1],["el_r","wr_r",.08],["hip_l","knee_l",.13],["knee_l","ank_l",.1],["hip_r","knee_r",.13],["knee_r","ank_r",.1]];
const BIG=["head","chest","lumbar"];let sel="knee_l",ST=null,T3=null,tg={skel:1,musc:0,joints:1,pain:1,dbg:0},loop3d=0;
function init3d(){
  const el=$("#inj3d");
  if(typeof THREE==="undefined"){el.innerHTML='<div class="mu" style="padding:20px">3D engine failed to load (Three.js CDN blocked). Check your connection and reload.</div>';return}
  if(T3){el.appendChild(T3.r.domElement);sz();return}
  const sc=new THREE.Scene(),cam=new THREE.PerspectiveCamera(32,1,.1,100),r=new THREE.WebGLRenderer({antialias:true,alpha:true}),root=new THREE.Group(),bones=new THREE.Group(),musc=new THREE.Group(),meshes=[];
  cam.position.set(0,0,17);sc.add(new THREE.AmbientLight(0xffffff,.75));const dl=new THREE.DirectionalLight(0xffffff,.9);dl.position.set(4,6,8);sc.add(dl);sc.add(root);root.add(bones,musc);musc.visible=false;
  const V=k=>new THREE.Vector3(REG[k][2],REG[k][3],REG[k][4]),up=new THREE.Vector3(0,1,0);
  const seg=(a,b,rad,mat,g)=>{const A=V(a),B=V(b),d=B.clone().sub(A),m=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,d.length(),14),mat);m.position.copy(A).add(B).multiplyScalar(.5);m.quaternion.setFromUnitVectors(up,d.normalize());g.add(m)};
  const bm=new THREE.MeshStandardMaterial({color:0x9db2c6,roughness:.5}),mm=new THREE.MeshStandardMaterial({color:0xc0504d,transparent:true,opacity:.55});
  LINKS.forEach(([a,b,w])=>{seg(a,b,w,bm,bones);if(a!=="head"&&a!=="lumbar")seg(a,b,w*2.3,mm,musc)});
  for(let n=0;n<6;n++){const t=new THREE.Mesh(new THREE.TorusGeometry(.62,.05,8,28),bm);t.position.set(0,3.0-n*.28,0);t.rotation.x=Math.PI/2;t.scale.set(1.05,.75,1);bones.add(t)}
  Object.entries(REG).forEach(([k,v])=>{const m=new THREE.Mesh(new THREE.SphereGeometry(v[5],26,18),new THREE.MeshStandardMaterial({color:0x9db2c6,roughness:.4}));m.position.set(v[2],v[3],v[4]);m.scale.set(...v[6]);m.userData.k=k;root.add(m);meshes.push(m)});
  T3={sc,cam,r,root,bones,musc,meshes,ty:0};
  const cv=r.domElement;let dn=null;cv.style.cssText="width:100%;height:100%;display:block;cursor:grab;touch-action:none";el.appendChild(cv);
  cv.onpointerdown=e=>{dn=[e.clientX,e.clientY];cv.setPointerCapture(e.pointerId)};
  cv.onpointermove=e=>{if(dn&&e.buttons){root.rotation.y+=(e.movementX||0)*.01;T3.ty=root.rotation.y}};
  cv.onpointerup=e=>{
    if(dn&&Math.hypot(e.clientX-dn[0],e.clientY-dn[1])<5){
      const b=cv.getBoundingClientRect(),rc=new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2((e.clientX-b.left)/b.width*2-1,-((e.clientY-b.top)/b.height)*2+1),cam);
      const h=rc.intersectObjects(meshes.filter(m=>m.visible))[0];
      if(h){sel=h.object.userData.k;updInj(true)}
    }
    dn=null;
  };
  // render loop: only draws while the injury tab is visible, so it costs nothing on other tabs
  (function frame(){loop3d=requestAnimationFrame(frame);const c=$("#inj3d");if(!c||!c.offsetParent)return;root.rotation.y+=(T3.ty-root.rotation.y)*.12;r.render(sc,cam)})();
  sz();
}
function sz(){const el=$("#inj3d");if(!el||!T3)return;const w=el.clientWidth,h=el.clientHeight;if(w&&h){T3.r.setPixelRatio(devicePixelRatio);T3.r.setSize(w,h,false);T3.cam.aspect=w/h;T3.cam.updateProjectionMatrix()}}
function paint(){
  if(!T3||!ST)return;
  T3.meshes.forEach(m=>{
    const k=m.userData.k,i=ST.injuries.find(x=>x.region===k),c=new THREE.Color(0x9db2c6);
    if(tg.pain&&i)c.set(i.sev>=6?0xf43f5e:i.sev>=3?0xf59e0b:0xfacc15);
    m.material.color.copy(c);m.material.emissive.set(k===sel?0x0b7a55:0);m.material.wireframe=!!tg.dbg;m.visible=BIG.includes(k)||!!tg.joints;
  });
  T3.bones.visible=!!tg.skel;T3.musc.visible=!!tg.musc;
}
window.tgl=k=>{tg[k]^=1;const b=$("#tg_"+k);if(k==="dbg")b.classList.toggle("on",!!tg[k]);else b.classList.toggle("off",!tg[k]);paint()};
window.setView=(y,b)=>{if(!T3)return;T3.ty=y;document.querySelectorAll(".vw").forEach(x=>{if(x.id!=="tg_dbg")x.classList.toggle("on",x===b)})};
async function injTab(){
  ST=await api("/api/dashboard");
  $("#p5").innerHTML=`<div class="card" style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap"><div><span class="tag" style="font:10px monospace;letter-spacing:1px;color:var(--g);background:#34d39914;border:1px solid #34d39940;padding:3px 10px;border-radius:99px">● 3D INJURY &amp; ANATOMICAL MAP</span><h1 style="font-size:30px;margin:12px 0 6px;font-weight:900">Musculoskeletal Assessment &amp; Adaptive Training Engine</h1><div class="mu" style="max-width:640px">Report anatomical discomfort, compute exercise loading impact, generate deterministic workout modifications, and track longitudinal recovery outcomes.</div></div><button class="btn" style="background:#101a2e;border:1px solid #1e2a44" onclick="clrInj()">🔄 Clear &amp; Start Fresh Assessment</button></div>
<div class="card" style="padding:12px"><input class="in" id="srch" placeholder="🔍  Search canonical anatomical structure (e.g. left_knee, shoulder, patella, lumbar)..." style="width:100%;padding:14px" onkeydown="if(event.key==='Enter')doSearch()"></div>
<div class="two" style="grid-template-columns:1.5fr 1fr"><div class="card"><div id="injT" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px"></div>
<div style="position:relative;background:#06080c;border:1px solid var(--bd);border-radius:14px;height:560px"><div class="ov" style="left:12px"><span class="mu" style="font:9px monospace">ANATOMY:</span><button class="tg ${tg.skel?"":"off"}" id="tg_skel" onclick="tgl('skel')">SKELETON</button><button class="tg ${tg.musc?"":"off"}" id="tg_musc" onclick="tgl('musc')">MUSCLES</button><button class="tg ${tg.joints?"":"off"}" id="tg_joints" onclick="tgl('joints')">JOINTS</button><button class="tg ${tg.pain?"":"off"}" id="tg_pain" onclick="tgl('pain')">PAIN MAP</button></div>
<div class="ov" style="right:12px"><button class="vw on" onclick="setView(0,this)">Front</button><button class="vw" onclick="setView(Math.PI,this)">Back</button><button class="vw" onclick="setView(-Math.PI/2,this)">Left</button><button class="vw" onclick="setView(Math.PI/2,this)">Right</button><button class="vw" onclick="setView(0,this)">Reset View</button><button class="vw ${tg.dbg?"on":""}" onclick="tgl('dbg')" id="tg_dbg">Debug</button></div><div id="inj3d" style="position:absolute;inset:0"></div></div></div><div class="card" id="injR"></div></div><div id="injB"></div>`;
  init3d();updInj(true);
}
window.doSearch=()=>{
  const q=$("#srch").value.toLowerCase().trim().replace(/[\s-]/g,"_");if(!q)return;
  const k=Object.keys(REG).find(k=>k.includes(q)||REG[k][0].toLowerCase().replace(/ /g,"_").includes(q));
  if(k){sel=k;updInj(true)}else alert("No matching structure found. Try: knee, shoulder, lumbar, ankle…");
};
const OPT={onset:["Today","This week","Weeks","Months"],trigger:["Workout","Daily activity","Rest","Unknown"],trend:["Same","Improving","Worsening"],act:["None","Mild","Moderate","Severe"]};
function updInj(){
  const cur=ST.injuries.find(i=>i.region===sel)||{pain:0,sore:0,stiff:0,tend:0,meta:{}},m=cur.meta||{},mx=Math.max(0,...ST.injuries.map(i=>i.sev)),R=REG[sel];
  $("#injT").innerHTML=`<div><div class="mu" style="font:10px monospace;letter-spacing:.8px">CANONICAL ANATOMY ID: ${esc(sel.toUpperCase())}</div><b style="color:var(--g);font-size:15px">${R[0]}</b></div><span style="font:10px monospace;background:#0a0d12;border:1px solid var(--bd);border-radius:99px;padding:6px 12px;align-self:center">${R[1]} → ${R[0]} → Anterior</span>`;
  const sl=(k,l,c)=>`<div><div style="display:flex;justify-content:space-between"><b>${l}</b><b class="mono" id="v_${k}" style="color:var(--g)">${+cur[k]||0} / 10</b></div><input type="range" id="s_${k}" min="0" max="10" value="${+cur[k]||0}" style="width:100%;accent-color:${c}" oninput="sliderIn()"><div style="display:flex;justify-content:space-between;font:9px monospace;color:var(--mu)"><span>0 (None)</span><span>10 (Severe)</span></div></div>`;
  const se=(k,l)=>`<label style="font:9px monospace;color:var(--mu);letter-spacing:.8px">${l}<select class="in" id="m_${k}" style="width:100%;padding:8px;margin-top:4px">${OPT[k].map(o=>`<option ${m[k]===o?"selected":""}>${o}</option>`).join("")}</select></label>`;
  $("#injR").innerHTML=`<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><b style="font-size:17px">● Reported Discomfort<br>Profile</b><div class="mu" style="font:11px monospace;margin-top:6px">Anatomical Target: <b style="color:var(--g)">${R[0]}</b></div></div><div style="display:flex;gap:6px"><span style="font:9px monospace;background:#151d2b;border:1px solid var(--bd);border-radius:8px;padding:6px 8px">IMPACT:<br>${mx>=6?"HIGH":mx>=3?"MODERATE":"MINIMAL"}</span><span style="font:10px monospace;height:fit-content;padding:6px 10px;border-radius:8px;${B(ST.recommendation)}">${esc(ST.recommendation)}</span></div></div>
<div style="background:#f59e0b12;border:1px solid #f59e0b40;color:#fcd9a0;border-radius:12px;padding:12px;margin:16px 0;font-size:12px">ℹ️ Based on your self-reported symptoms. This is not a medical diagnosis. If you have severe pain, numbness, or a suspected fracture, see a clinician.</div>
<div style="background:#080a0f;border:1px solid var(--bd);border-radius:14px;padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:16px">${sl("pain","Pain","#f43f5e")}${sl("sore","Soreness","#f59e0b")}${sl("stiff","Stiffness","#38bdf8")}${sl("tend","Tenderness","#10b981")}</div>
<div style="display:flex;justify-content:space-between;background:#080a0f;border:1px solid var(--bd);border-radius:12px;padding:14px;margin:14px 0"><span class="mu" style="font:11px monospace">DOMINANT SYMPTOM</span><b id="dom" style="color:var(--g);font-family:monospace"></b></div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${se("onset","ONSET")}${se("trigger","TRIGGER")}${se("trend","TREND")}${se("act","ACTIVITY IMPACT")}</div><button class="btn" style="width:100%;margin-top:14px" onclick="saveInj()">Save discomfort report</button>`;
  sliderIn();
  const LV={HIGH:"#f43f5e",MODERATE:"#f59e0b",NONE:"#34d399"};
  $("#injB").innerHTML=`<div class="two" style="grid-template-columns:1fr 1fr"><div class="card"><div class="mu" style="font:12px monospace;margin-bottom:10px">TODAY'S TRAINING DECISION ENGINE</div><div style="background:#34d39910;border:1px solid #34d39940;border-radius:14px;padding:14px"><div style="display:flex;justify-content:space-between;gap:8px"><span class="mu" style="font:10px monospace">TRAINING ACTION</span><b style="padding:5px 14px;border-radius:99px;${B(ST.recommendation)}">ACTION: ${esc(ST.recommendation)}</b></div><p style="margin:10px 0 0">${esc(ST.reason)}</p></div></div>
<div class="card"><div class="mu" style="font:12px monospace;margin-bottom:10px">PLANNED EXERCISE IMPACT ANALYSIS</div>${ST.impact.map(e=>`<div class="r"><div><b>${esc(e.name)}</b><div class="mu" style="font-size:12px">${e.hit.length?"Overlap: "+e.hit.map(h=>REG[h]?REG[h][0]:esc(h)).join(", ")+" ("+(+e.sev)+"/10)":"No anatomical loading overlap with active discomfort."}</div></div><span class="p" style="font:10px monospace;color:${LV[e.level]||"var(--mu)"}">${e.level==="NONE"?"NO SIGNIFICANT OVERLAP":esc(e.level)+" TRAINING IMPACT"}</span></div>`).join("")}</div></div>
<div class="card"><div class="mu" style="font:12px monospace;margin-bottom:10px">DISCOMFORT HISTORY &amp; RECURRENCE</div><div id="injHist" class="mu">Loading…</div></div>`;
  paint();loadInjHistory();
}
async function loadInjHistory(){
  try{
    const h=await api("/api/injury/history"),SC={worsening:"#f43f5e",improving:"#34d399",resolved:"#38bdf8"};
    $("#injHist").innerHTML=h.length?h.slice(0,10).map(x=>`<div class="r"><b>${REG[x.region]?REG[x.region][0]:esc(x.region)}</b><span class="mu">${esc(new Date(x.t).toLocaleDateString())}</span><span class="p" style="font-size:11px;color:${SC[x.status]||"var(--mu)"}">${esc(String(x.status).toUpperCase())} · ${+x.sev}/10</span></div>`).join(""):'<p class="mu">No history yet — save a discomfort report to start tracking recurrence.</p>';
  }catch(e){const el=$("#injHist");if(el)el.textContent="Couldn't load history."}
}
window.sliderIn=()=>{
  const v={pain:+$("#s_pain").value,sore:+$("#s_sore").value,stiff:+$("#s_stiff").value,tend:+$("#s_tend").value},N={pain:"Pain",sore:"Soreness",stiff:"Stiffness",tend:"Tenderness"};
  for(const k in v)$("#v_"+k).textContent=v[k]+" / 10";
  const mk=Object.keys(v).sort((a,b)=>v[b]-v[a])[0];
  $("#dom").textContent=v[mk]?N[mk]+" — "+v[mk]+"/10":"None — 0/10";
};
window.saveInj=async()=>{
  try{
    const r=await api("/api/injury","PUT",{region:sel,pain:+$("#s_pain").value,sore:+$("#s_sore").value,stiff:+$("#s_stiff").value,tend:+$("#s_tend").value,meta:{onset:$("#m_onset").value,trigger:$("#m_trigger").value,trend:$("#m_trend").value,act:$("#m_act").value}});
    ST={...ST,...r};updInj();
  }catch(e){fail(e)}
};
window.clrInj=async()=>{
  if(!confirm("Clear all reported discomfort areas?"))return;
  try{const r=await api("/api/injury","DELETE");ST={...ST,...r};updInj()}catch(e){fail(e)}
};
addEventListener("resize",()=>{if(T3&&$("#inj3d"))sz()});
if(TOKEN)api("/api/dashboard").then(boot).catch(()=>{});