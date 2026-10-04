import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
const dir = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = process.env.NODE_ENV === "production";
const ALLOW_DEMO = !PRODUCTION || process.env.DEMO === "1";          // seed + fake Strava sync
const REQUIRE_VERIFIED = process.env.REQUIRE_VERIFIED === "1";        // block unverified users from data endpoints
const TZ_OFFSET_MIN = Number.isFinite(+process.env.TZ_OFFSET_MIN) ? +process.env.TZ_OFFSET_MIN : 330; // IST; used for "calendar day" buckets
const KEY = process.env.SERPAPI_KEY;
const D = 864e5;

// ---- JWT secret: never fall back to a publicly-known default ----
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (PRODUCTION) { console.error("FATAL: JWT_SECRET must be set when NODE_ENV=production"); process.exit(1); }
  SECRET = crypto.randomBytes(48).toString("hex");
  console.warn("WARNING: JWT_SECRET not set — using a random one for this run. Logins will reset on restart.");
}

if (process.env.TRUST_PROXY) app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// ---- tiny JSON "database" (swap for MongoDB/SQLite later; same shape) ----
const F = path.join(dir, "db.json");
const EMPTY = () => ({ users: [], logs: [], checkins: [], injuries: [], injuryHistory: [], vision: [], plans: [], carts: [], synced: [], healthPairs: [], healthDevices: [], healthData: [] });
let db = EMPTY();
if (fs.existsSync(F)) {
  try { db = { ...EMPTY(), ...JSON.parse(fs.readFileSync(F, "utf8")) }; }
  catch (e) {
    const bak = F + ".corrupt-" + Date.now();
    fs.renameSync(F, bak);
    console.error("db.json was unreadable; moved to " + bak + " and starting fresh.");
  }
}
// atomic write: a crash mid-write can no longer leave a half-written db.json
const save = () => {
  const tmp = F + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, F);
};
const id = () => crypto.randomUUID();
const mine = (k, uid) => db[k].filter(r => r.uid === uid);
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // async errors -> error handler
const int = (v, min, max) => { const n = Number(v); return v !== "" && v != null && Number.isFinite(n) && n >= min && n <= max ? n : null; };
const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

// ---- rate limiting ----
function limiter(max, windowMs) {
  const m = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of m) if (n - v.t > windowMs) m.delete(k); }, windowMs).unref();
  return {
    blocked: k => { const r = m.get(k); return !!r && Date.now() - r.t <= windowMs && r.n >= max; },
    hit: k => { const n = Date.now(); let r = m.get(k); if (!r || n - r.t > windowMs) { r = { n: 0, t: n }; m.set(k, r); } r.n++; return r.n > max; }, // true => over limit
    reset: k => m.delete(k)
  };
}
const limit = (lim, keyFn, msg = "Too many requests. Please slow down.") => (req, res, next) =>
  lim.hit(keyFn(req)) ? res.status(429).json({ error: msg }) : next();

const loginByAcct = limiter(5, 15 * 60e3);   // email + ip, FAILED attempts only
const loginByIp = limiter(30, 15 * 60e3);    // stops one IP spraying many emails
const registerLim = limiter(10, 60 * 60e3);
const claimLim = limiter(10, 15 * 60e3);     // pairing-code guesses per IP
const syncLim = limiter(120, 60e3);
const pairLim = limiter(10, 10 * 60e3);
const priceLim = limiter(20, 60e3);
const verifyLim = limiter(5, 15 * 60e3);
const resendLim = limiter(3, 60 * 60e3);

// ---- auth ----
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10); // equalises timing for unknown emails
const tok = u => ({ token: jwt.sign({ uid: u.id }, SECRET, { expiresIn: "7d" }), name: u.name, verified: u.verified });
const bearer = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ""); return m ? m[1] : null; };
const auth = (req, res, next) => {
  try {
    const t = bearer(req); if (!t) throw 0;
    const uid = jwt.verify(t, SECRET, { algorithms: ["HS256"] }).uid;
    const u = db.users.find(x => x.id === uid); if (!u) throw 0;
    req.uid = uid; req.user = u; next();
  } catch { res.status(401).json({ error: "Login required" }); }
};
// optional hard gate (REQUIRE_VERIFIED=1). Dashboard + verify endpoints stay open so the user can finish verifying.
const verified = (req, res, next) =>
  (!REQUIRE_VERIFIED || req.user.verified) ? next() : res.status(403).json({ error: "Please verify your email first." });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Demo mode: no real SMTP, so the code is returned in the response ONLY outside production.
// Wire in Nodemailer + SMTP here to send it for real.
const newCode = () => String(crypto.randomInt(100000, 1000000));

app.post("/api/auth/register", limit(registerLim, r => r.ip, "Too many sign-ups from this network. Try later."), ah(async (req, res) => {
  const name = str(req.body.name, 60), email = str(req.body.email, 254)?.toLowerCase(), password = req.body.password;
  if (!name || !email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid name and email are required" });
  if (typeof password !== "string" || password.length < 6 || password.length > 72) return res.status(400).json({ error: "Password must be 6–72 characters" });
  if (db.users.find(u => u.email === email)) return res.status(409).json({ error: "Email already registered" });
  const code = newCode();
  const u = { id: id(), name, email, hash: await bcrypt.hash(password, 10), verified: false, verifyCode: code, verifyTries: 0 };
  db.users.push(u); save();
  res.json({ ...tok(u), ...(PRODUCTION ? {} : { devVerifyCode: code }) });
}));
app.post("/api/auth/verify", auth, limit(verifyLim, r => r.uid, "Too many attempts. Request a new code."), (req, res) => {
  const u = req.user;
  if (u.verified) return res.json({ verified: true });
  if (!u.verifyCode || u.verifyCode !== String(req.body.code || "").trim()) return res.status(400).json({ error: "Incorrect verification code" });
  u.verified = true; u.verifyCode = null; save(); res.json({ verified: true });
});
app.post("/api/auth/resend", auth, limit(resendLim, r => r.uid, "Too many code requests. Try again later."), (req, res) => {
  const u = req.user;
  if (u.verified) return res.json({ verified: true });
  u.verifyCode = newCode(); save();
  res.json({ ok: true, ...(PRODUCTION ? {} : { devVerifyCode: u.verifyCode }) });
});
app.post("/api/auth/login", ah(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), acct = email + "|" + req.ip;
  if (loginByAcct.blocked(acct) || loginByIp.blocked(req.ip))
    return res.status(429).json({ error: "Too many failed login attempts. Try again in a few minutes." });
  const u = db.users.find(x => x.email === email);
  const ok = await bcrypt.compare(String(req.body.password || ""), u ? u.hash : DUMMY_HASH);
  if (!u || !ok) { loginByAcct.hit(acct); loginByIp.hit(req.ip); return res.status(401).json({ error: "Wrong email or password" }); }
  loginByAcct.reset(acct);   // successful logins no longer count toward the lockout
  res.json(tok(u));
}));

// ---- engines ----
const dayNo = t => Math.floor((t + TZ_OFFSET_MIN * 60e3) / D);   // calendar-day index in the configured time zone
function acwr(uid) {
  const now = Date.now(), L = mine("logs", uid).filter(l => now - l.t <= 28 * D);
  const sum = d => L.filter(l => now - l.t <= d * D).reduce((a, l) => a + l.min * l.rpe, 0);
  const a = sum(7) / 7, c = sum(28) / 28;
  if (!c) return { acute: 0, chronic: 0, ratio: 0, band: "BUILDING" };   // no data yet: honest "building", not a fake 1.0
  const r = a / c, young = now - Math.min(...L.map(l => l.t)) < 14 * D;
  return { acute: Math.round(a * 7), chronic: Math.round(c * 28), ratio: +r.toFixed(2),
    band: young ? "BUILDING" : r < .8 ? "LOW" : r <= 1.3 ? "OPTIMAL" : r <= 1.5 ? "ELEVATED" : "HIGH" };
}
const PLAN = [["Squat", ["knee_l", "knee_r", "hip_l", "hip_r"]], ["Lunge", ["knee_l", "knee_r", "hip_l", "hip_r"]], ["Leg Press", ["knee_l", "knee_r", "hip_l", "hip_r"]], ["Calf Raise", ["ank_l", "ank_r", "knee_l", "knee_r"]], ["Bench Press", ["sh_l", "sh_r", "chest", "el_l", "el_r"]], ["Bicep Curl", ["el_l", "el_r", "wr_l", "wr_r"]], ["Deadlift", ["lumbar", "hip_l", "hip_r"]]];
function state(uid) {
  const inj = mine("injuries", uid), ci = mine("checkins", uid).slice(-1)[0] || null, w = acwr(uid), m = Math.max(0, ...inj.map(i => i.sev));
  // a check-in older than ~36h shouldn't drive today's decision
  const f = ci && Date.now() - ci.t < 36 * 3600e3 ? ci : null;
  let rec = "TRAIN", why = "Workload and recovery metrics within optimal training zone.";
  if (m >= 8 || (f && f.pain >= 7)) [rec, why] = ["RECOVERY", m >= 8 ? "Severe active injury reported." : "High pain reported in today's check-in."];
  else if (w.band === "HIGH" || (f && (f.sleep < 5 || f.ready < 40))) [rec, why] = ["POSTPONE", "High workload spike or severe sleep/readiness deficit."];
  else if (m >= 6) [rec, why] = ["POSTPONE", `High discomfort (${m}/10) overlaps planned exercises. Postpone heavy affected loads.`];
  else if (w.band === "ELEVATED" || (f && f.sore >= 6) || m >= 4) [rec, why] = ["MODIFY", "Elevated load or discomfort. Reduce intensity by 20-30%."];
  const impact = PLAN.map(([n, rs]) => { const hit = inj.filter(i => rs.includes(i.region)); const s = Math.max(0, ...hit.map(i => i.sev)); return { name: n, level: s >= 6 ? "HIGH" : s >= 3 ? "MODERATE" : "NONE", hit: hit.map(i => i.region), sev: s }; });
  return { acwr: w, checkin: ci, injuries: inj, recommendation: rec, reason: why, impact };
}

// ---- plan generator: BMR (Mifflin-St Jeor) -> TDEE -> macros -> Indian meals ----
const MEALS = {
  veg: ["Paneer bhurji + 2 roti", "Dal, rice, sabzi, curd", "Roasted chana + milk", "Soya chunks curry + roti + salad"],
  nonveg: ["3 egg omelette + 2 roti", "Chicken curry, rice, dal", "Boiled eggs + banana", "Grilled fish/chicken + sabzi + roti"],
  egg: ["3 egg bhurji + 2 roti", "Dal, rice, sabzi, curd", "Boiled eggs + fruit", "Egg curry + roti + salad"],
  vegan: ["Tofu scramble + 2 roti", "Rajma/chole, rice, sabzi", "Sprouts + peanut chikki", "Soya chunks curry + roti + salad"]
};
const SPLIT = { strength: ["Squat 5x5, Bench 5x5", "Deadlift 3x5, Row 4x6", "OHP 5x5, Pull-ups 4x6"], hypertrophy: ["Chest+Triceps 4x10", "Back+Biceps 4x10", "Legs 4x10", "Shoulders+Core 4x12"], endurance: ["Run 40 min Z2", "Circuit 3 rounds", "Cycle/Row 45 min"], fatloss: ["Full body 3x12", "HIIT 20 min + core", "Full body 3x12", "Brisk walk 45 min"] };
const ACT = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 };
app.post("/api/plan", auth, verified, (req, res) => {
  const b = req.body, age = int(b.age, 11, 100), h = int(b.height, 101, 250), w = int(b.weight, 26, 300);
  if (age == null || h == null || w == null) return res.status(400).json({ error: "Enter valid age (11-100), height (101-250 cm), weight (26-300 kg)" });
  const gender = ["male", "female"].includes(b.gender) ? b.gender : null, goal = Object.keys(SPLIT).includes(b.goal) ? b.goal : null,
    activity = b.activity in ACT ? b.activity : null, diet = b.diet in MEALS ? b.diet : null;
  if (!gender || !goal || !activity || !diet) return res.status(400).json({ error: "Choose a valid gender, goal, activity level and diet" });
  const bmr = 10 * w + 6.25 * h - 5 * age + (gender === "female" ? -161 : 5), tdee = bmr * ACT[activity];
  const raw = goal === "fatloss" ? tdee * .82 : goal === "hypertrophy" || goal === "strength" ? tdee * 1.1 : tdee;
  const kcal = Math.round(Math.max(raw, gender === "female" ? 1200 : 1500));   // safety floor so a "fat loss" plan can't go dangerously low
  const protein = Math.round(w * (goal === "strength" ? 2.2 : 2.0)), fat = Math.round(kcal * .25 / 9), carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const split = [.25, .35, .15, .25], names = ["Breakfast", "Lunch", "Snacks", "Dinner"], meals = MEALS[diet];
  const micro = diet === "veg" || diet === "vegan" ? "Watch Vitamin B12, Vitamin D, Iron, Zinc — consider fortified foods/supplements after a blood test." : "Keep Vitamin D and Iron in check with regular blood tests.";
  const plan = { uid: req.uid, id: id(), profile: { age, height: h, weight: w, gender, goal, activity, diet }, bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, protein, carbs, fat, micro,
    meals: names.map((n, i) => ({ meal: n, food: meals[i], kcal: Math.round(kcal * split[i]) })), workouts: SPLIT[goal].map((d, i) => ({ day: "Day " + (i + 1), work: d })) };
  db.plans = db.plans.filter(x => x.uid !== req.uid); db.plans.push(plan); save(); res.json(plan);
});
app.get("/api/plan", auth, (req, res) => res.json(mine("plans", req.uid)[0] || null));

// ---- logging endpoints ----
app.post("/api/logs", auth, verified, (req, res) => {
  const min = int(req.body.min, 1, 600), rpe = int(req.body.rpe, 1, 10);
  if (min == null || rpe == null) return res.status(400).json({ error: "Duration 1-600 min and RPE 1-10 required" });
  db.logs.push({ uid: req.uid, t: Date.now(), min, rpe, type: "manual", load: min * rpe }); save(); res.json(acwr(req.uid));
});
app.post("/api/checkin", auth, verified, (req, res) => {
  const sleep = int(req.body.sleep, 0, 24), sore = int(req.body.sore, 0, 10), pain = int(req.body.pain, 0, 10), ready = int(req.body.ready, 0, 100);
  if ([sleep, sore, pain, ready].some(v => v == null)) return res.status(400).json({ error: "Sleep (0-24h), soreness (0-10), pain (0-10) and readiness (0-100) are all required" });
  db.checkins.push({ uid: req.uid, t: Date.now(), sleep, sore, pain, ready }); save(); res.json(state(req.uid));
});

const REGIONS = ["head", "chest", "lumbar", "sh_l", "sh_r", "el_l", "el_r", "wr_l", "wr_r", "hip_l", "hip_r", "knee_l", "knee_r", "ank_l", "ank_r"];
const META_OPT = { onset: ["Today", "This week", "Weeks", "Months"], trigger: ["Workout", "Daily activity", "Rest", "Unknown"], trend: ["Same", "Improving", "Worsening"], act: ["None", "Mild", "Moderate", "Severe"] };
app.put("/api/injury", auth, verified, (req, res) => {
  const { region } = req.body;
  if (!REGIONS.includes(region)) return res.status(400).json({ error: "Unknown anatomical region" });
  const v = k => int(Math.round(Number(req.body[k] ?? 0)), 0, 10);
  const pain = v("pain"), sore = v("sore"), stiff = v("stiff"), tend = v("tend");
  if ([pain, sore, stiff, tend].some(x => x == null)) return res.status(400).json({ error: "Scores must be between 0 and 10" });
  const meta = {}; for (const k in META_OPT) if (META_OPT[k].includes((req.body.meta || {})[k])) meta[k] = req.body.meta[k];
  const sev = Math.max(pain, sore, stiff, tend);
  const prev = db.injuries.find(i => i.uid === req.uid && i.region === region);
  const status = sev === 0 ? "resolved" : prev ? (sev > prev.sev ? "worsening" : sev < prev.sev ? "improving" : "unchanged") : "new";
  db.injuries = db.injuries.filter(i => !(i.uid === req.uid && i.region === region));
  if (sev > 0) db.injuries.push({ uid: req.uid, region, pain, sore, stiff, tend, sev, meta, status, t: Date.now() });
  db.injuryHistory.push({ uid: req.uid, region, sev, status, t: Date.now() }); // recurrence/trend log
  save(); res.json(state(req.uid));
});
app.delete("/api/injury", auth, verified, (req, res) => { db.injuries = db.injuries.filter(i => i.uid !== req.uid); save(); res.json(state(req.uid)); });
app.get("/api/injury/history", auth, (req, res) => res.json(mine("injuryHistory", req.uid).slice(-30).reverse()));

// AI Form Check sessions. The camera gives reps + quality but no duration/RPE, so we ESTIMATE the load
// (≈0.5 min per rep, RPE 6) and store the estimate consistently in both `min`/`rpe` and `load`.
app.post("/api/vision", auth, verified, (req, res) => {
  const exercise = str(req.body.exercise, 40), reps = int(req.body.reps, 0, 2000), quality = int(req.body.quality, 0, 100);
  if (!exercise || reps == null || quality == null) return res.status(400).json({ error: "Valid exercise, reps and quality required" });
  db.vision.push({ uid: req.uid, t: Date.now(), exercise, reps, quality });
  if (reps > 0) { const min = Math.max(5, Math.round(reps * .5)), rpe = 6; db.logs.push({ uid: req.uid, t: Date.now(), min, rpe, type: "vision", load: min * rpe }); }
  save(); res.json({ ok: true });
});

app.post("/api/seed", auth, (req, res) => {
  if (!ALLOW_DEMO) return res.status(403).json({ error: "Demo data is disabled in production" });
  const now = Date.now();
  db.logs = db.logs.filter(l => !(l.uid === req.uid && l.type === "seed"));
  for (let i = 27; i >= 1; i -= 2) { const rpe = 6 + (i % 3 === 0 ? 1 : 0); db.logs.push({ uid: req.uid, t: now - i * D - 36e5, min: 45, rpe, type: "seed", load: 45 * rpe }); }
  save(); res.json({ ok: true, acwr: acwr(req.uid) });
});

app.get("/api/dashboard", auth, (req, res) => {
  const u = req.user, L = mine("logs", req.uid), now = Date.now(), today = dayNo(now);
  // 28-day consistency heatmap (calendar days in TZ_OFFSET_MIN) + readiness trend
  const heatmap = Array.from({ length: 28 }, (_, i) => ({ day: i, load: L.filter(l => dayNo(l.t) === today - (27 - i)).reduce((a, l) => a + l.min * l.rpe, 0) }));
  const readinessTrend = mine("checkins", req.uid).slice(-14).map(c => ({ t: c.t, ready: c.ready, sleep: c.sleep }));
  const act = new Set(L.filter(l => now - l.t <= 28 * D).map(l => dayNo(l.t))).size, V = mine("vision", req.uid);
  const ld = (a, b) => L.filter(l => { const x = now - l.t; return x >= a * D && x <= b * D; }).reduce((q, l) => q + l.min * l.rpe, 0);
  const recent = ld(0, 14), prior = ld(14, 28), hcRow = mine("healthData", req.uid).sort((a, b) => b.syncedAt - a.syncedAt)[0] || null;
  const consistency = Math.min(100, Math.round(act / 16 * 100)), quality = V.length ? Math.round(V.reduce((q, v) => q + v.quality, 0) / V.length) : null;
  const strength = prior ? Math.max(-100, Math.min(300, Math.round((recent - prior) / prior * 100))) : 0;   // change in training load, last 14d vs prior 14d
  const perf = { ready: L.length >= 3, sessions: L.length, consistency, quality, strength, score: Math.round(consistency * .4 + (quality ?? consistency) * .3 + Math.max(0, Math.min(100, 50 + strength)) * .3) };
  const devices = (hcRow ? 1 : 0) + (db.synced.some(x => x.uid === req.uid) ? 1 : 0);
  res.json({ ...state(req.uid), perf, devices, name: u.name, verified: u.verified, plan: mine("plans", req.uid)[0] || null, sessions: V.slice(-5).reverse(), logs: L.length, heatmap, readinessTrend, cart: mine("carts", req.uid), healthConnect: hcRow });
});

// ---- wearable integrations (demo) ----
// Full OAuth is out of scope here (needs real API keys). The idempotent ingest IS real: each activity has a stable
// provider_activityId composite key, so re-syncing never duplicates logs. Demo activities get stable, realistic
// timestamps (1/3/5 days ago) instead of "now", so ACWR windows are not skewed.
const DEMO_ACTIVITIES = p => [{ id: "a1", min: 42, rpe: 6, daysAgo: 1 }, { id: "a2", min: 55, rpe: 7, daysAgo: 3 }, { id: "a3", min: 30, rpe: 5, daysAgo: 5 }].map(a => ({ ...a, compositeId: `${p}_${a.id}` }));
app.post("/api/wearable/sync", auth, verified, (req, res) => {
  if (!ALLOW_DEMO) return res.status(403).json({ error: "Demo wearable sync is disabled in production" });
  const provider = ["strava"].includes(req.body.provider) ? req.body.provider : "strava", acts = DEMO_ACTIVITIES(provider);
  let added = 0;
  for (const a of acts) {
    if (db.synced.find(s => s.uid === req.uid && s.compositeId === a.compositeId)) continue; // already ingested
    db.logs.push({ uid: req.uid, t: Date.now() - a.daysAgo * D, min: a.min, rpe: a.rpe, type: "wearable:" + provider, load: a.min * a.rpe });
    db.synced.push({ uid: req.uid, compositeId: a.compositeId, t: Date.now() });
    added++;
  }
  save(); res.json({ status: "SUCCESS", imported: added, skipped: acts.length - added, acwr: acwr(req.uid) });
});

// ---- Android Health Connect bridge ----
// The browser can't read Health Connect. The companion Android app does, then talks to this server in 2 steps:
//   1) POST /api/healthconnect/claim {code, device}  -> trades the one-time pairing code for a long-lived device token
//   2) POST /api/healthconnect/sync  (Authorization: Bearer <deviceToken>) {steps, calories, avgHeartRate, ...}
// The 6-digit code is single-use, unique among active codes, expires in 10 min, and claim attempts are rate-limited per IP,
// so it can't be brute-forced and a leaked code is useless after first use.
app.post("/api/healthconnect/pair", auth, verified, limit(pairLim, r => r.uid), (req, res) => {
  const now = Date.now();
  db.healthPairs = db.healthPairs.filter(p => p.expiresAt > now && !p.usedAt && p.uid !== req.uid);
  let code; do { code = newCode(); } while (db.healthPairs.some(p => p.code === code));
  const expiresAt = now + 10 * 60e3;
  db.healthPairs.push({ uid: req.uid, code, createdAt: now, expiresAt, usedAt: null });
  save();
  res.json({ code, expiresAt, message: "Enter this code in the AegisFit Android app." });
});
app.post("/api/healthconnect/claim", limit(claimLim, r => r.ip, "Too many pairing attempts. Try again later."), (req, res) => {
  const now = Date.now(), code = String(req.body?.code || "");
  const pair = db.healthPairs.find(p => p.code === code && p.expiresAt > now && !p.usedAt);
  if (!pair) return res.status(401).json({ error: "Invalid or expired pairing code. Generate a new code in AegisFit Devices." });
  pair.usedAt = now;
  const deviceToken = crypto.randomBytes(32).toString("hex");
  db.healthDevices = db.healthDevices.filter(d => d.uid !== pair.uid);   // re-pairing replaces the old device
  db.healthDevices.push({ uid: pair.uid, tokenHash: sha(deviceToken), device: str(req.body?.device, 40) || "Android", createdAt: now });
  save();
  res.json({ ok: true, deviceToken });
});
app.get("/api/healthconnect/status", auth, (req, res) => {
  const row = mine("healthData", req.uid).sort((a, b) => b.syncedAt - a.syncedAt)[0] || null;
  res.json({ connected: !!row, lastSync: row?.syncedAt || null, data: row ? { steps: row.steps, calories: row.calories, avgHeartRate: row.avgHeartRate } : null });
});
app.delete("/api/healthconnect", auth, (req, res) => {
  db.healthDevices = db.healthDevices.filter(d => d.uid !== req.uid);
  db.healthData = db.healthData.filter(d => d.uid !== req.uid);
  db.healthPairs = db.healthPairs.filter(p => p.uid !== req.uid);
  save(); res.json({ ok: true });
});
app.post("/api/healthconnect/sync", (req, res, next) => {
  const t = bearer(req), dev = t && db.healthDevices.find(d => d.tokenHash === sha(t));
  if (!dev) return res.status(401).json({ error: "Invalid device token. Pair the device again from AegisFit Devices." });
  req.uid = dev.uid; req.devToken = dev.tokenHash; next();
}, limit(syncLim, r => r.devToken), (req, res) => {
  const b = req.body || {};
  const steps = int(b.steps ?? 0, 0, 200000), calories = int(b.calories ?? 0, 0, 20000), hr = b.avgHeartRate == null ? null : int(b.avgHeartRate, 20, 250);
  if (steps == null || calories == null || (b.avgHeartRate != null && hr == null)) return res.status(400).json({ error: "Metrics out of range" });
  const clean = { uid: req.uid, steps, calories, avgHeartRate: hr, startTime: str(b.startTime, 40), endTime: str(b.endTime, 40), device: str(b.device, 40) || "Android", syncedAt: Date.now() };
  db.healthData = db.healthData.filter(x => x.uid !== req.uid);
  db.healthData.push(clean); save();
  res.json({ ok: true, syncedAt: clean.syncedAt, data: { steps, calories, avgHeartRate: hr } });
});

// ---- cart ----
app.get("/api/cart", auth, (req, res) => res.json(mine("carts", req.uid)));
app.post("/api/cart", auth, (req, res) => {
  const name = str(req.body.name, 300), source = str(req.body.source, 80) || "Store", price = Number(req.body.price);
  if (!name || !Number.isFinite(price) || price < 0 || price > 1e8) return res.status(400).json({ error: "Valid product name and price required" });
  if (mine("carts", req.uid).length >= 50) return res.status(400).json({ error: "Cart is full (50 items max)" });
  db.carts.push({ uid: req.uid, id: id(), name, price, source, t: Date.now() }); save(); res.json(mine("carts", req.uid));
});
app.delete("/api/cart/:id", auth, (req, res) => { db.carts = db.carts.filter(c => !(c.uid === req.uid && c.id === req.params.id)); save(); res.json(mine("carts", req.uid)); });

app.use(express.static(path.join(dir, "client")));

// ---- price comparison: Google Shopping (India) via SerpAPI, now behind login, rate-limited and cached ----
const priceCache = new Map();   // q -> {t, results}
app.get("/api/prices", auth, limit(priceLim, r => r.uid), ah(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  if (!KEY) {
    const e = encodeURIComponent(q);
    return res.json({ noKey: true, results: [
      { source: "Amazon.in", link: `https://www.amazon.in/s?k=${e}&s=price-asc-rank` },
      { source: "Flipkart", link: `https://www.flipkart.com/search?q=${e}&sort=price_asc` },
      { source: "Decathlon", link: `https://www.decathlon.in/search?Ntt=${e}` },
      { source: "Myntra", link: `https://www.myntra.com/${e}?sort=price_asc` }] });
  }
  const ck = q.toLowerCase(), hit = priceCache.get(ck);
  if (hit && Date.now() - hit.t < 10 * 60e3) return res.json({ results: hit.results });
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({ engine: "google_shopping", q, gl: "in", hl: "en", api_key: KEY });
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok || j.error) { console.error("SerpAPI error:", j.error || r.status); return res.status(502).json({ error: "Price service unavailable. Try again shortly." }); }
    const results = (j.shopping_results || [])
      .filter(x => Number.isFinite(x.extracted_price))
      .map(x => ({ title: String(x.title || ""), price: x.extracted_price, priceText: x.price, source: x.source, link: x.product_link || x.link, thumb: x.thumbnail }))
      .sort((a, b) => a.price - b.price);
    if (priceCache.size > 200) priceCache.clear();
    priceCache.set(ck, { t: Date.now(), results });
    res.json({ results });
  } catch (e) { console.error("prices:", e); res.status(502).json({ error: "Price service unavailable. Try again shortly." }); }
}));

// ---- 404 for unknown API routes + central error handler ----
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const PORT = +process.env.PORT || 3000;
app.listen(PORT, process.env.HOST || undefined, () => console.log(`AegisFit running -> http://localhost:${PORT}`));