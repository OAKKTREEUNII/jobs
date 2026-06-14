/**
 * OAKKTREEUNII Job Pipeline (enriched, multi-source)
 * ------------------------------------------------------------------
 * Runs server-side (GitHub Actions) every 6 hours.
 *   1. Pulls IT PM & Scrum Master roles from multiple FREE sources:
 *        - Adzuna (US + Canada)                [needs free app id/key]
 *        - Greenhouse / Lever / Ashby ATS      [no key — curated companies]
 *        - The Muse                            [no key]
 *        - Remotive                            [no key, remote]
 *        - USAJobs                             [optional, free key]
 *   2. De-dupes, scores by intent, and ENRICHES each job:
 *        seniority, work mode, sponsorship signal, certs, years of
 *        experience, pay-vs-market, a template "why it fits", TL;DR.
 *   3. Writes a static jobs.json (served by GitHub Pages -> Framer).
 *   4. (Optional) Mirrors rows into a Notion database.
 *
 * No npm dependencies — uses Node 18+ global fetch.
 * ================================================================== */

"use strict";
const fs = require("fs");

/* ------------------------------ CONFIG ---------------------------- */
const ADZUNA_APP_ID  = process.env.ADZUNA_APP_ID  || "";
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || "";
const USAJOBS_KEY    = process.env.USAJOBS_KEY   || "";   // optional
const USAJOBS_EMAIL  = process.env.USAJOBS_EMAIL || "";   // optional
const NOTION_TOKEN       = process.env.NOTION_TOKEN || "";
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || "";

const QUERIES = ["scrum master","agile coach","release train engineer","it project manager","technical project manager","agile delivery manager","agile project manager","technical program manager"];

// Curated target companies for direct ATS pulls. EDIT THESE.
// Find the slug in a company's careers URL, e.g. boards.greenhouse.io/<slug>
const ATS = {
  greenhouse: ["stripe","databricks","airtable","gitlab"],
  lever:      ["plaid","brex"],
  ashby:      ["ramp","linear"]
};

const RESULTS_PER_PAGE = 50;
const MIN_SCORE_KEEP   = 35;
const OUTPUT_FILE      = "jobs.json";

/* --------------------------- INTENT ENGINE ------------------------ */
const CORE_TITLES = ["scrum master","agile coach","release train engineer","rte","it project manager","technical project manager","digital project manager","software project manager","agile project manager","agile delivery manager","delivery lead","delivery manager","iteration manager","agile delivery lead","technical program manager","it program manager"];
const GENERIC_TITLES = ["project manager","program manager","project lead","pmo","project coordinator","program lead","portfolio manager"];
const TECH_SIGNALS = ["agile","scrum","sprint","kanban","backlog","jira","confluence","sdlc","software","saas","cloud","devops","it ","information technology","technology","digital","engineering","platform","ceremonies","stand-up","standup","stakeholder","roadmap","product owner","release","deployment","azure","aws","data","application","systems"];
const NEG = ["construction","civil engineer","mechanical","electrical contractor","hvac","plumbing","oil & gas","oilfield","restaurant","retail store","grocery","warehouse associate","nurse","clinical trial","cnc","welding","real estate agent","event planner","wedding","logistics driver","truck","landscap","janitor","housekeep","food service","manufacturing line"];

const lc = (s) => (s || "").toLowerCase();
const has = (h, n) => h.indexOf(n) !== -1;

function scoreJob(job) {
  const title = lc(job.title), desc = lc(job.description || ""), all = title + " " + desc;
  let score = 0; const reasons = [];
  for (const n of NEG) { if (has(title, n)) { score -= 45; reasons.push("off-domain title"); break; } }
  for (const n of NEG) { if (has(desc, n)) { score -= 8; break; } }
  let coreHit = false;
  for (const c of CORE_TITLES) { if (has(title, c)) { score += 58; coreHit = true; reasons.push("core role: " + c); break; } }
  if (!coreHit) { for (const c of CORE_TITLES) { if (has(desc, c)) { score += 22; reasons.push("role in description"); break; } } }
  let genericHit = false;
  for (const g of GENERIC_TITLES) { if (has(title, g)) { genericHit = true; break; } }
  if (genericHit && !coreHit) {
    score += 20; let ctx = 0;
    for (const t of TECH_SIGNALS) { if (has(all, t)) ctx++; }
    if (ctx >= 2) { score += 22; reasons.push("PM + tech context"); } else { score -= 6; }
  }
  let sig = 0; for (const s of TECH_SIGNALS) { if (has(all, s)) sig++; }
  score += Math.min(sig, 8) * 3;
  if (has(all, "scrum") && has(all, "agile")) { score += 6; reasons.push("agile delivery"); }
  if (has(all, "safe") || has(all, "scaled agile")) score += 5;
  if (has(all, "csm") || has(all, "psm") || has(all, "pmp") || has(all, "pmi-acp")) { score += 5; reasons.push("certification fit"); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons: reasons.slice(0, 3) };
}

/* --------------------------- ENRICHMENT --------------------------- */
function seniority(title, desc){
  const t = lc(title), d = lc(desc);
  if (/\b(senior|sr\.?|lead|principal|head|director|staff|manager iii)\b/.test(t)) return "Senior";
  if (/\b(junior|jr\.?|associate|entry|coordinator|assistant|intern)\b/.test(t)) return "Junior";
  if (/\b(10\+|8\+|7\+)\s*years/.test(d)) return "Senior";
  return "Mid";
}
function workMode(title, desc, location){
  const all = lc(title + " " + desc + " " + location);
  if (/\bhybrid\b/.test(all)) return "Hybrid";
  if (/\b(remote|work from home|wfh|distributed|anywhere)\b/.test(all) && !/\b(no remote|onsite only|on-site only|not remote)\b/.test(all)) return "Remote";
  if (/\b(on-?site|in office|in-office)\b/.test(all)) return "Onsite";
  return "Onsite";
}
function sponsorship(desc){
  const d = lc(desc);
  if (/\b(no (visa )?sponsorship|not able to sponsor|cannot sponsor|unable to sponsor|without sponsorship|do(es)? not (offer|provide) sponsorship)\b/.test(d)) return "none";
  if (/\b(u\.?s\.? citizen|citizenship required|must be a citizen|security clearance|active clearance)\b/.test(d)) return "citizens";
  if (/\b(visa sponsorship|will sponsor|sponsorship (is )?available|open to sponsorship|h-?1b|lmia|relocation and sponsorship)\b/.test(d)) return "friendly";
  return "unknown";
}
const CERT_PATTERNS = [
  [/\bpsm\s*(ii|2)\b/i,"PSM II"], [/\bpsm\s*(iii|3)\b/i,"PSM III"], [/\bpsm\b/i,"PSM"],
  [/\bcsm\b/i,"CSM"], [/\bcspo\b/i,"CSPO"], [/\bpspo\b/i,"PSPO"],
  [/\bsafe\b|scaled agile/i,"SAFe"], [/\bpmp\b/i,"PMP"], [/\bpmi-?acp\b/i,"PMI-ACP"],
  [/\bicp-?acc\b/i,"ICP-ACC"], [/\bprince2\b/i,"PRINCE2"], [/\bcal\b/i,"CAL"]
];
function certs(text){
  const out = []; const seen = new Set();
  for (const [re, name] of CERT_PATTERNS) { if (re.test(text) && !seen.has(name)) { seen.add(name); out.push(name); } }
  // collapse PSM family to the most specific
  if (out.includes("PSM III") || out.includes("PSM II")) { const i = out.indexOf("PSM"); if (i>-1) out.splice(i,1); }
  return out.slice(0, 4);
}
function yearsExp(desc){
  const m = lc(desc).match(/(\d{1,2})\s*\+?\s*(?:to|-)?\s*\d{0,2}\s*years?(?:[^.]{0,24})?(?:experience|exp\b)/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 15) return n; }
  const m2 = lc(desc).match(/(\d{1,2})\s*\+\s*years?/);
  if (m2) { const n = parseInt(m2[1], 10); if (n >= 1 && n <= 15) return n; }
  return null;
}
function roleKey(title){const t=lc(title);if(has(t,"scrum")||has(t,"agile coach")||has(t,"rte")||has(t,"release train"))return"scrum";if(has(t,"program")||has(t,"portfolio"))return"program";if(has(t,"project manager")||has(t,"delivery")||has(t,"pmo"))return"itpm";return"generic";}
function senKey(s){return s==="Senior"?"senior":(s==="Junior"?"junior":"mid");}

const PAY_TABLE = {
  us: { scrum:{junior:[72000,92000],mid:[98000,132000],senior:[135000,175000]}, itpm:{junior:[78000,98000],mid:[105000,140000],senior:[140000,185000]}, program:{junior:[95000,120000],mid:[125000,160000],senior:[160000,210000]}, generic:{junior:[68000,88000],mid:[92000,122000],senior:[125000,160000]} },
  ca: { scrum:{junior:[70000,88000],mid:[92000,120000],senior:[122000,155000]}, itpm:{junior:[74000,94000],mid:[98000,128000],senior:[130000,165000]}, program:{junior:[90000,112000],mid:[118000,150000],senior:[150000,190000]}, generic:{junior:[64000,82000],mid:[86000,112000],senior:[116000,148000]} }
};
function fmtMoney(n,cur){return(cur==="CAD"?"C$":"$")+Math.round(n/1000)+"k";}
function payInfo(job, sen){
  const cur = job.country==="ca"?"CAD":"USD";
  const band = PAY_TABLE[job.country||"us"][roleKey(job.title)][senKey(sen)];
  const marketMid = (band[0]+band[1])/2;
  if (job.salary_min && job.salary_max && job.salary_min>1000) {
    const mid=(job.salary_min+job.salary_max)/2;
    let vs="At market"; if(mid>marketMid*1.08) vs="Above market"; else if(mid<marketMid*0.92) vs="Below market";
    return {text:fmtMoney(job.salary_min,cur)+" – "+fmtMoney(job.salary_max,cur)+" /yr", est:!!job.salary_is_predicted, mid:mid, vsMarket:vs};
  }
  if (job.salary_min && job.salary_min>1000)
    return {text:"from "+fmtMoney(job.salary_min,cur)+" /yr", est:!!job.salary_is_predicted, mid:job.salary_min, vsMarket:null};
  return {text:fmtMoney(band[0],cur)+" – "+fmtMoney(band[1],cur)+" /yr", est:true, mid:marketMid, vsMarket:null};
}
function whyFit(job, sen){
  const role = {scrum:"agile-coaching role",itpm:"software-delivery PM role",program:"program-level leadership role",generic:"delivery role"}[roleKey(job.title)];
  const mode = job.workMode === "Remote" ? ", fully remote" : (job.workMode === "Hybrid" ? ", hybrid" : "");
  let tail = "";
  if (job.sponsorship === "friendly") tail = " Open to visa sponsorship.";
  else if (job.sponsorship === "none") tail = " Note: no sponsorship offered.";
  else if (job.sponsorship === "citizens") tail = " Note: citizenship/clearance required.";
  return `${sen} ${role}${mode} — a strong fit for an IT PM / Scrum Master profile.${tail}`;
}
function tldr(desc, job){
  const clean = (desc||"").replace(/\s+/g," ").trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(s => s.length>=35 && s.length<=180);
  const VERBS = ["facilitate","lead","manage","coach","drive","own","coordinate","deliver","partner","responsible","require","support","collaborate","plan"];
  const ranked = sentences.map(s => { const l=lc(s); let v=0; for(const x of VERBS) if(has(l,x)) v++; return {s, v}; })
                          .sort((a,b)=>b.v-a.v).slice(0,3).map(o=>o.s);
  const bullets = ranked.length ? ranked : sentences.slice(0,3);
  if (job.sponsorship==="none") bullets.push("No visa sponsorship — must be authorized to work locally.");
  else if (job.sponsorship==="citizens") bullets.push("Requires citizenship or ability to obtain clearance.");
  else if (job.sponsorship==="friendly") bullets.push("Open to visa sponsorship.");
  return bullets.slice(0,3);
}
/* --- Location parsing (city + state/province) --- */
const US_STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia"};
const CA_PROV = {ON:"Ontario",QC:"Quebec",BC:"British Columbia",AB:"Alberta",MB:"Manitoba",SK:"Saskatchewan",NS:"Nova Scotia",NB:"New Brunswick",NL:"Newfoundland and Labrador",PE:"Prince Edward Island",YT:"Yukon",NT:"Northwest Territories",NU:"Nunavut"};
const ALL_REGIONS = Object.assign({}, US_STATES, CA_PROV);
const NAME_TO_ABBR = {}; for (const k in ALL_REGIONS) NAME_TO_ABBR[ALL_REGIONS[k].toLowerCase()] = k;
function parseLocation(loc){
  let s = (loc||"").replace(/\(.*?\)/g," ").replace(/\bremote\b/ig," ").replace(/[\-—–|\/]/g," ").replace(/\s+/g," ").trim();
  if(!s) return {city:"", state:""};
  const parts = s.split(",").map(p=>p.trim()).filter(Boolean);
  let city="", state="";
  for(let i=0;i<parts.length;i++){
    const up = parts[i].toUpperCase().replace(/\./g,"");
    if(ALL_REGIONS[up]){ state=ALL_REGIONS[up]; if(i>0) city=parts[i-1]; break; }
    const nm = NAME_TO_ABBR[parts[i].toLowerCase()];
    if(nm){ state=ALL_REGIONS[nm]; if(i>0) city=parts[i-1]; break; }
  }
  if(!city && parts[0] && !/united states|u\.?s\.?a?|canada|anywhere/i.test(parts[0])) city=parts[0];
  if(/united states|u\.?s\.?a?|canada|anywhere|remote/i.test(city)) city="";
  return {city:city, state:state};
}

/* --- Industry / domain --- */
function industryOf(job){
  const t = lc(job.company+" "+job.title+" "+(job.description||""));
  if(/\b(bank|fintech|financial|payments?|trading|lending|credit union|capital|invest|brokerage|wealth|mortgage)\b/.test(t)) return "Finance";
  if(/\b(insurance|insurer|underwrit|actuar)\b/.test(t)) return "Insurance";
  if(/\b(health|hospital|clinical|ehr|medical|pharma|biotech|patient|medicaid|medicare|life sciences)\b/.test(t)) return "Healthcare";
  if(/\b(government|public sector|federal|municipal|\bgov\b|defense|defence|state of|city of|county of)\b/.test(t)) return "Government";
  if(/\b(retail|e-?commerce|commerce|shopping|consumer goods|merchandis)\b/.test(t)) return "Retail";
  if(/\b(university|edtech|education|school|academ|e-?learning)\b/.test(t)) return "Education";
  if(/\b(telecom|wireless|broadband|network operator)\b/.test(t)) return "Telecom";
  return "Technology";
}

/* --- Company size (best-effort dictionary; others = Unknown) --- */
const COMPANY_SIZE = {
  "stripe":"Large","databricks":"Large","gitlab":"Large","google":"Large","alphabet":"Large","amazon":"Large","aws":"Large","microsoft":"Large","apple":"Large","meta":"Large","facebook":"Large","netflix":"Large","ibm":"Large","oracle":"Large","salesforce":"Large","sap":"Large","adobe":"Large","intuit":"Large","paypal":"Large","cisco":"Large","dell":"Large","intel":"Large","nvidia":"Large","accenture":"Large","deloitte":"Large","pwc":"Large","kpmg":"Large","ey":"Large","capgemini":"Large","cognizant":"Large","infosys":"Large","tcs":"Large","tata consultancy services":"Large","wipro":"Large","hcl":"Large","atos":"Large","dxc":"Large","kyndryl":"Large","cgi":"Large","jpmorgan":"Large","jpmorgan chase":"Large","bank of america":"Large","wells fargo":"Large","citi":"Large","citigroup":"Large","goldman sachs":"Large","morgan stanley":"Large","american express":"Large","visa":"Large","mastercard":"Large","rbc":"Large","royal bank of canada":"Large","td bank":"Large","scotiabank":"Large","bmo":"Large","cibc":"Large","manulife":"Large","sun life":"Large","shopify":"Large","uber":"Large","lyft":"Large","airbnb":"Large","atlassian":"Large","servicenow":"Large","workday":"Large","vmware":"Large","telus":"Large","rogers":"Large","bell":"Large","walmart":"Large","target":"Large","costco":"Large","fedex":"Large","ups":"Large","unitedhealth":"Large","cvs":"Large","figma":"Large",
  "airtable":"Midsize","brex":"Midsize","ramp":"Midsize","notion":"Midsize","plaid":"Midsize","retool":"Midsize","mixpanel":"Midsize","asana":"Midsize","gusto":"Midsize","calendly":"Midsize","webflow":"Midsize","miro":"Midsize",
  "linear":"Startup","vercel":"Startup","supabase":"Startup","posthog":"Startup","render":"Startup","replit":"Startup","hex":"Startup","dbt labs":"Startup","fly.io":"Startup"
};
function companySizeOf(company){
  const c = lc(company).replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|technologies|technology|solutions)\b/g," ").replace(/[.,]/g," ").replace(/\s+/g," ").trim();
  if(!c || c==="company not disclosed") return "Unknown";
  if(COMPANY_SIZE[c]) return COMPANY_SIZE[c];
  for(const k in COMPANY_SIZE){ if(k.length>=4 && (c===k || c.indexOf(k+" ")===0 || c.indexOf(" "+k)!==-1)) return COMPANY_SIZE[k]; }
  return "Unknown";
}

/* --- Career-switcher friendly --- */
function entryFriendlyOf(job, sen){
  const d = lc(job.description||"");
  const training = /(will train|we.{0,6}train|no experience|entry.level|career (change|switch|transition)|bootcamp|eager to learn|mentorship|new grad|recent grad|degree or equivalent|equivalent experience|no degree required)/.test(d);
  const lowExp = (job.yoe===null || job.yoe<=2);
  return sen!=="Senior" && lowExp && (job.certs.length===0 || training);
}

function enrich(job){
  const intent = scoreJob(job);
  const sen = seniority(job.title, job.description);
  job.workMode = workMode(job.title, job.description, job.location);
  job.sponsorship = sponsorship(job.description);
  const text = job.title + " " + (job.description||"");
  job.seniority = sen;
  job.certs = certs(text);
  job.yoe = yearsExp(job.description);
  job.pay = payInfo(job, sen);
  job.score = intent.score;
  job.reasons = intent.reasons;
  job.remote = job.workMode === "Remote";
  job.whyFit = whyFit(job, sen);
  job.tldr = tldr(job.description, job);
  const loc = parseLocation(job.location);
  job.city = loc.city;
  job.state = loc.state;
  job.industry = industryOf(job);
  job.companySize = companySizeOf(job.company);
  job.entryFriendly = entryFriendlyOf(job, sen);
  job.direct = ["Greenhouse","Lever","Ashby"].indexOf(job.source) !== -1;
  return job;
}

/* ------------------------- SOURCE HELPERS ------------------------- */
const clean = (s) => (s||"").replace(/<[^>]+>/g," ").replace(/&[a-z]+;/g," ").replace(/\s+/g," ").trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function inferCountry(loc){
  const l = lc(loc);
  if (/canada|ontario|quebec|british columbia|alberta|\b(on|qc|bc|ab|mb|sk|ns|nb)\b|toronto|montreal|vancouver|calgary|ottawa/.test(l)) return "ca";
  return "us";
}
function baseJob(o){ return Object.assign({ id:"", title:"", company:"Company not disclosed", recruiter:"Not disclosed", location:"", country:"us", created:null, url:"#", description:"", salary_min:null, salary_max:null, salary_is_predicted:false, source:"" }, o); }

async function getJSON(url, opts){ const res = await fetch(url, opts); if(!res.ok) throw new Error(url.split("?")[0]+" -> "+res.status); return res.json(); }

/* Adzuna */
async function pullAdzuna(){
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) { console.warn("Adzuna skipped (no keys)."); return []; }
  const out = [];
  for (const country of ["us","ca"]) for (const q of QUERIES) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}&results_per_page=${RESULTS_PER_PAGE}&what=${encodeURIComponent(q)}&content-type=application/json`;
      const j = await getJSON(url);
      for (const r of (j.results||[])) out.push(baseJob({
        id:String(r.id||""), title:clean(r.title), company:r.company&&r.company.display_name?clean(r.company.display_name):"Company not disclosed",
        recruiter:r.company&&r.company.display_name?clean(r.company.display_name):"Not disclosed",
        location:r.location&&r.location.display_name?clean(r.location.display_name):(country==="ca"?"Canada":"United States"),
        country, created:r.created||null, url:r.redirect_url||"#", description:clean(r.description).slice(0,1200),
        salary_min:r.salary_min||null, salary_max:r.salary_max||null,
        salary_is_predicted:(r.salary_is_predicted==="1"||r.salary_is_predicted===1), source:"Adzuna" }));
      await sleep(300);
    } catch(e){ console.warn("Adzuna:", e.message); }
  }
  return out;
}
/* Greenhouse */
async function pullGreenhouse(){
  const out = [];
  for (const c of (ATS.greenhouse||[])) {
    try {
      const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${c}/jobs?content=true`);
      for (const r of (j.jobs||[])) out.push(baseJob({
        id:"gh-"+r.id, title:clean(r.title), company:c, recruiter:c+" (careers)",
        location:clean(r.location&&r.location.name), country:inferCountry(r.location&&r.location.name),
        created:r.updated_at||null, url:r.absolute_url||"#", description:clean(r.content).slice(0,1200), source:"Greenhouse" }));
      await sleep(200);
    } catch(e){ console.warn("Greenhouse "+c+":", e.message); }
  }
  return out;
}
/* Lever */
async function pullLever(){
  const out = [];
  for (const c of (ATS.lever||[])) {
    try {
      const j = await getJSON(`https://api.lever.co/v0/postings/${c}?mode=json`);
      for (const r of (j||[])) out.push(baseJob({
        id:"lv-"+r.id, title:clean(r.text), company:c, recruiter:c+" (careers)",
        location:clean(r.categories&&r.categories.location), country:inferCountry(r.categories&&r.categories.location),
        created:r.createdAt?new Date(r.createdAt).toISOString():null, url:r.hostedUrl||"#",
        description:clean(r.descriptionPlain||r.description).slice(0,1200), source:"Lever" }));
      await sleep(200);
    } catch(e){ console.warn("Lever "+c+":", e.message); }
  }
  return out;
}
/* Ashby */
async function pullAshby(){
  const out = [];
  for (const c of (ATS.ashby||[])) {
    try {
      const j = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${c}?includeCompensation=true`);
      for (const r of (j.jobs||[])) out.push(baseJob({
        id:" as-"+(r.id||r.jobId), title:clean(r.title), company:c, recruiter:c+" (careers)",
        location:clean(r.location||r.locationName), country:inferCountry(r.location||r.locationName),
        created:r.publishedAt||null, url:r.jobUrl||r.applyUrl||"#", description:clean(r.descriptionPlain||r.description).slice(0,1200), source:"Ashby" }));
      await sleep(200);
    } catch(e){ console.warn("Ashby "+c+":", e.message); }
  }
  return out;
}
/* The Muse */
async function pullMuse(){
  const out = [];
  try {
    for (let page=0; page<2; page++){
      const j = await getJSON(`https://www.themuse.com/api/public/jobs?category=Project%20Management&page=${page}`);
      for (const r of (j.results||[])) {
        const locName = (r.locations&&r.locations[0]&&r.locations[0].name)||"";
        out.push(baseJob({ id:"muse-"+r.id, title:clean(r.name), company:r.company&&r.company.name?clean(r.company.name):"Company not disclosed",
          recruiter:r.company&&r.company.name?clean(r.company.name):"Not disclosed", location:clean(locName),
          country:inferCountry(locName), created:r.publication_date||null,
          url:(r.refs&&r.refs.landing_page)||"#", description:clean(r.contents).slice(0,1200), source:"The Muse" }));
      }
      await sleep(300);
    }
  } catch(e){ console.warn("The Muse:", e.message); }
  return out;
}
/* Remotive */
async function pullRemotive(){
  const out = [];
  for (const q of ["project manager","scrum master"]) {
    try {
      const j = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=40`);
      for (const r of (j.jobs||[])) out.push(baseJob({
        id:"rmt-"+r.id, title:clean(r.title), company:clean(r.company_name), recruiter:clean(r.company_name)||"Not disclosed",
        location:clean(r.candidate_required_location)||"Remote", country:inferCountry(r.candidate_required_location),
        created:r.publication_date||null, url:r.url||"#", description:clean(r.description).slice(0,1200), source:"Remotive" }));
      await sleep(300);
    } catch(e){ console.warn("Remotive:", e.message); }
  }
  return out;
}
/* USAJobs (optional) */
async function pullUSAJobs(){
  if (!USAJOBS_KEY || !USAJOBS_EMAIL) return [];
  const out = [];
  for (const q of ["scrum master","IT project manager"]) {
    try {
      const j = await getJSON(`https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(q)}&ResultsPerPage=25`,
        { headers:{ "Host":"data.usajobs.gov", "User-Agent":USAJOBS_EMAIL, "Authorization-Key":USAJOBS_KEY } });
      for (const item of (j.SearchResult&&j.SearchResult.SearchResultItems||[])) {
        const d = item.MatchedObjectDescriptor||{}; const rem = (d.PositionRemuneration&&d.PositionRemuneration[0])||{};
        out.push(baseJob({ id:"usa-"+d.PositionID, title:clean(d.PositionTitle), company:clean(d.OrganizationName)||"US Government",
          recruiter:clean(d.OrganizationName)||"US Government", location:clean(d.PositionLocationDisplay), country:"us",
          created:d.PublicationStartDate||null, url:d.PositionURI||"#", description:clean(d.UserArea&&d.UserArea.Details&&d.UserArea.Details.JobSummary).slice(0,1200),
          salary_min:rem.MinimumRange?Number(rem.MinimumRange):null, salary_max:rem.MaximumRange?Number(rem.MaximumRange):null, source:"USAJobs" }));
      }
      await sleep(300);
    } catch(e){ console.warn("USAJobs:", e.message); }
  }
  return out;
}

function dedupe(jobs){
  const seen = new Set(); const out = [];
  for (const j of jobs) {
    const key = (j.url && j.url !== "#") ? j.url.split("?")[0] : (lc(j.title)+"|"+lc(j.company)+"|"+lc(j.location));
    if (seen.has(key)) continue; seen.add(key); out.push(j);
  }
  return out;
}

/* ------------------------- NOTION MIRROR -------------------------- */
const NOTION_API = "https://api.notion.com/v1";
const nh = { "Authorization":"Bearer "+NOTION_TOKEN, "Notion-Version":"2022-06-28", "Content-Type":"application/json" };
const rt = (s) => ({ rich_text:[{ text:{ content:(s||"").slice(0,1900) } }] });
const tl = (s) => ({ title:[{ text:{ content:(s||"").slice(0,1900) } }] });
const SPON_LABEL = { friendly:"Sponsorship-friendly", none:"No sponsorship", citizens:"Citizens/clearance", unknown:"Not stated" };
function notionProps(j){
  const p = {
    "Name": tl(j.title), "Company": rt(j.company), "Recruiter": rt(j.recruiter), "Location": rt(j.location),
    "Country": { select:{ name:j.country==="ca"?"Canada":"US" } }, "Pay": rt(j.pay.text + (j.pay.est?" (est)":"")),
    "Match": { number:j.score }, "Seniority": { select:{ name:j.seniority } }, "Work mode": { select:{ name:j.workMode } },
    "Sponsorship": { select:{ name:SPON_LABEL[j.sponsorship] } }, "Experience": rt(j.yoe?(j.yoe+"+ years"):"Not stated"),
    "Certs": rt(j.certs.join(", ")), "Source": { select:{ name:j.source||"Adzuna" } },
    "Remote": { checkbox:!!j.remote }, "URL": { url:(j.url&&j.url!=="#")?j.url:null }, "JobID": rt(j.id)
  };
  if (j.created) p["Posted"] = { date:{ start:j.created } };
  return p;
}
async function notionFind(id){
  try {
    const r = await fetch(`${NOTION_API}/databases/${NOTION_DATABASE_ID}/query`, { method:"POST", headers:nh,
      body:JSON.stringify({ filter:{ property:"JobID", rich_text:{ equals:id } }, page_size:1 }) });
    if(!r.ok) return null; const j = await r.json(); return j.results&&j.results[0]?j.results[0].id:null;
  } catch { return null; }
}
async function syncNotion(jobs){
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) { console.log("Notion mirror skipped."); return; }
  let created=0, updated=0;
  for (const j of jobs) {
    try {
      const ex = await notionFind(j.id); const props = notionProps(j);
      if (ex) { await fetch(`${NOTION_API}/pages/${ex}`, { method:"PATCH", headers:nh, body:JSON.stringify({ properties:props }) }); updated++; }
      else { await fetch(`${NOTION_API}/pages`, { method:"POST", headers:nh, body:JSON.stringify({ parent:{ database_id:NOTION_DATABASE_ID }, properties:props }) }); created++; }
      await sleep(340);
    } catch(e){ console.warn("Notion row:", e.message); }
  }
  console.log(`Notion mirror: ${created} created, ${updated} updated.`);
}

/* ------------------------------ MAIN ------------------------------ */
(async () => {
  console.log("Pulling sources...");
  const results = await Promise.all([
    pullAdzuna(), pullGreenhouse(), pullLever(), pullAshby(), pullMuse(), pullRemotive(), pullUSAJobs()
  ]);
  let raw = dedupe(results.reduce((a,b)=>a.concat(b), []));
  console.log(`Raw de-duped: ${raw.length}`);

  const enriched = raw.map(enrich)
    .filter(j => j.score >= MIN_SCORE_KEEP)
    .sort((a,b) => b.score - a.score || (new Date(b.created||0) - new Date(a.created||0)));

  const bySource = {};
  enriched.forEach(j => { bySource[j.source] = (bySource[j.source]||0)+1; });
  const payload = { generated_at:new Date().toISOString(), count:enriched.length, sources:bySource, jobs:enriched };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
  console.log(`Wrote ${OUTPUT_FILE}: ${enriched.length} jobs`, bySource);

  await syncNotion(enriched);
  console.log("Done.");
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
