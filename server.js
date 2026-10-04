import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
const app = express(); app.use(express.json());
const dir = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.SERPAPI_KEY, SECRET = process.env.JWT_SECRET || "change-me-AgeisFit";
const F = path.join(dir, "db.json"); // swap for MongoDB/Mongoose later; same shape
const db = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F)) : { users: [], logs: [], checkins: [], injuries: [], injuryHistory: [], vision: [], plans: [], carts: [], synced: [], healthPairs: [], healthData: [] };
for (const k of ["injuryHistory", "carts", "synced", "healthPairs", "healthData"]) if (!db[k]) db[k] = []; // migrate older db.json files
const save = () => fs.writeFileSync(F, JSON.stringify(db));
const id = () => Math.random().toString(36).slice(2);
const auth = (req, res, next) => { try { req.uid = jwt.verify((req.headers.authorization || "").slice(7), SECRET).uid; next(); } catch { res.status(401).json({ error: "Login required" }); } };
const tok = u => ({ token: jwt.sign({ uid: u.id }, SECRET, { expiresIn: "7d" }), name: u.name, verified: u.verified });

// ---- login rate limiting (brute-force protection, per report §5 Authentication Module) ----
const attempts = new Map();
const rateLimited = (req, res, next) => {
  const k = (req.body.email || "").toLowerCase() + "|" + req.ip, now = Date.now();
  const rec = attempts.get(k) || { n: 0, t: now };
  if (now - rec.t > 15 * 60e3) { rec.n = 0; rec.t = now; }
  if (rec.n >= 5) return res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  rec.n++; attempts.set(k, rec); next();
};

// ---- auth: bcrypt(10 rounds) + JWT(7d) + simulated double opt-in email verification ----
// No real SMTP is configured in this demo, so the "email" is simulated: the verification
// code is returned directly in the API response instead of being sent out. Wire in
// Nodemailer + SMTP/Ethereal here to send it for real, per report §5 Authentication Module.
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: "Name, email, password (6+ chars) required" });
  if (db.users.find(u => u.email === email.toLowerCase())) return res.status(409).json({ error: "Email already registered" });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const u = { id: id(), name, email: email.toLowerCase(), hash: await bcrypt.hash(password, 10), verified: false, verifyCode: code };
  db.users.push(u); save(); res.json({ ...tok(u), devVerifyCode: code });
});
app.post("/api/auth/verify", auth, (req, res) => {
  const u = db.users.find(x => x.id === req.uid);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (u.verifyCode !== String(req.body.code || "")) return res.status(400).json({ error: "Incorrect verification code" });
  u.verified = true; save(); res.json({ verified: true });
});
app.post("/api/auth/login", rateLimited, async (req, res) => {
  const u = db.users.find(x => x.email === (req.body.email || "").toLowerCase());
  if (!u || !(await bcrypt.compare(req.body.password || "", u.hash))) return res.status(401).json({ error: "Wrong email or password" });
  res.json(tok(u));
});

// ---- engines (from the report) ----
const mine = (k, uid) => db[k].filter(r => r.uid === uid);
function acwr(uid) {
  const now = Date.now(), D = 864e5, L = mine("logs", uid), sum = d => L.filter(l => now - l.t <= d * D).reduce((a, l) => a + l.min * l.rpe, 0);
  const a = sum(7) / 7, c = sum(28) / 28; if (!c) return { acute: 0, chronic: 0, ratio: 1, band: "OPTIMAL" };
  const r = a / c, young = now - Math.min(...L.map(l => l.t)) < 14 * D; return { acute: Math.round(a * 7), chronic: Math.round(c * 28), ratio: +r.toFixed(2), band: young ? "BUILDING" : r < .8 ? "LOW" : r <= 1.3 ? "OPTIMAL" : r <= 1.5 ? "ELEVATED" : "HIGH" };
}
const PLAN = [["Squat", ["knee_l", "knee_r", "hip_l", "hip_r"]], ["Lunge", ["knee_l", "knee_r", "hip_l", "hip_r"]], ["Leg Press", ["knee_l", "knee_r", "hip_l", "hip_r"]], ["Calf Raise", ["ank_l", "ank_r", "knee_l", "knee_r"]], ["Bench Press", ["sh_l", "sh_r", "chest", "el_l", "el_r"]], ["Bicep Curl", ["el_l", "el_r", "wr_l", "wr_r"]], ["Deadlift", ["lumbar", "hip_l", "hip_r"]]];
function state(uid) {
  const inj = mine("injuries", uid), ci = mine("checkins", uid).slice(-1)[0] || null, w = acwr(uid), m = Math.max(0, ...inj.map(i => i.sev));
  let rec = "TRAIN", why = "Workload and recovery metrics within optimal training zone.";
  if (ci && (m >= 8 || ci.pain >= 7)) [rec, why] = ["RECOVERY", "High pain or severe active injury reported."];
  else if (m >= 8) [rec, why] = ["RECOVERY", "Severe active injury reported."];
  else if (w.band === "HIGH" || (ci && (ci.sleep < 5 || ci.ready < 40))) [rec, why] = ["POSTPONE", "High workload spike or severe sleep/readiness deficit."];
  else if (m >= 6) [rec, why] = ["POSTPONE", `High discomfort (${m}/10) overlaps planned exercises. Postpone heavy affected loads.`];
  else if (w.band === "ELEVATED" || (ci && ci.sore >= 6) || m >= 4) [rec, why] = ["MODIFY", "Elevated load or discomfort. Reduce intensity by 20-30%."];
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
app.post("/api/plan", auth, (req, res) => {
  const p = req.body, age = +p.age, h = +p.height, w = +p.weight;
  if (!(age > 10 && h > 100 && w > 25)) return res.status(400).json({ error: "Enter valid age, height (cm), weight (kg)" });
  const bmr = 10 * w + 6.25 * h - 5 * age + (p.gender === "female" ? -161 : 5);
  const tdee = bmr * ({ sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 }[p.activity] || 1.55);
  const kcal = Math.round(p.goal === "fatloss" ? tdee * .82 : p.goal === "hypertrophy" || p.goal === "strength" ? tdee * 1.1 : tdee);
  const protein = Math.round(w * (p.goal === "strength" ? 2.2 : 2.0)), fat = Math.round(kcal * .25 / 9), carbs = Math.round((kcal - protein * 4 - fat * 9) / 4);
  const split = [.25, .35, .15, .25], names = ["Breakfast", "Lunch", "Snacks", "Dinner"], diet = MEALS[p.diet] || MEALS.veg;
  const micro = p.diet === "veg" || p.diet === "vegan" ? "Watch Vitamin B12, Vitamin D, Iron, Zinc — consider fortified foods/supplements after a blood test." : "Keep Vitamin D and Iron in check with regular blood tests.";
  const plan = { uid: req.uid, id: id(), profile: p, bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, protein, carbs, fat, micro,
    meals: names.map((n, i) => ({ meal: n, food: diet[i], kcal: Math.round(kcal * split[i]) })), workouts: (SPLIT[p.goal] || SPLIT.hypertrophy).map((d, i) => ({ day: "Day " + (i + 1), work: d })) };
  db.plans = db.plans.filter(x => x.uid !== req.uid); db.plans.push(plan); save(); res.json(plan);
});
app.get("/api/plan", auth, (req, res) => res.json(mine("plans", req.uid)[0] || null));

// ---- logging endpoints ----
app.post("/api/logs", auth, (req, res) => { const min = +req.body.min, rpe = +req.body.rpe; if (!(min > 0 && rpe >= 1 && rpe <= 10)) return res.status(400).json({ error: "Duration >0 and RPE 1-10" }); db.logs.push({ uid: req.uid, t: Date.now(), min, rpe, type: req.body.type || "manual", load: min * rpe }); save(); res.json(acwr(req.uid)); });
app.post("/api/checkin", auth, (req, res) => { const c = { uid: req.uid, t: Date.now(), sleep: +req.body.sleep, sore: +req.body.sore, pain: +req.body.pain, ready: +req.body.ready }; db.checkins.push(c); save(); res.json(state(req.uid)); });
app.put("/api/injury", auth, (req, res) => {
  const { region, pain = 0, sore = 0, stiff = 0, tend = 0, meta = {} } = req.body, sev = Math.max(pain, sore, stiff, tend);
  const prev = db.injuries.find(i => i.uid === req.uid && i.region === region);
  const status = sev === 0 ? "resolved" : prev ? (sev > prev.sev ? "worsening" : sev < prev.sev ? "improving" : "unchanged") : "new";
  db.injuries = db.injuries.filter(i => !(i.uid === req.uid && i.region === region));
  if (sev > 0) db.injuries.push({ uid: req.uid, region, pain, sore, stiff, tend, sev, meta, status, t: Date.now() });
  db.injuryHistory.push({ uid: req.uid, region, sev, status, t: Date.now() }); // recurrence/trend log, report §3 Discomfort & Injury Engine
  save(); res.json(state(req.uid));
});
app.delete("/api/injury", auth, (req, res) => { db.injuries = db.injuries.filter(i => i.uid !== req.uid); save(); res.json(state(req.uid)); });
app.get("/api/injury/history", auth, (req, res) => res.json(mine("injuryHistory", req.uid).slice(-30).reverse()));
app.post("/api/vision", auth, (req, res) => { const { exercise, reps, quality } = req.body; db.vision.push({ uid: req.uid, t: Date.now(), exercise, reps, quality }); if (reps > 0) db.logs.push({ uid: req.uid, t: Date.now(), min: Math.max(5, Math.round(reps * .5)), rpe: 6, type: "vision", load: 0 }); save(); res.json({ ok: true }); });
app.get("/api/dashboard", auth, (req, res) => {
  const u = db.users.find(x => x.id === req.uid), L = mine("logs", req.uid), now = Date.now(), D = 864e5;
  // Recovery & Analytics (report §3 Recovery & Analytics): 28-day consistency heatmap + readiness trend
  const heatmap = Array.from({ length: 28 }, (_, i) => { const day0 = now - (27 - i) * D; const load = L.filter(l => Math.floor(l.t / D) === Math.floor(day0 / D)).reduce((a, l) => a + l.min * l.rpe, 0); return { day: i, load }; });
  const readinessTrend = mine("checkins", req.uid).slice(-14).map(c => ({ t: c.t, ready: c.ready, sleep: c.sleep }));
  res.json({ ...state(req.uid), name: u.name, verified: u.verified, plan: mine("plans", req.uid)[0] || null, sessions: mine("vision", req.uid).slice(-5).reverse(), logs: L.length, heatmap, readinessTrend, cart: mine("carts", req.uid), healthConnect: mine("healthData", req.uid).sort((a,b)=>b.syncedAt-a.syncedAt)[0] || null });
});

// ---- wearable integrations: OAuth lifecycle is out of scope for this demo (needs real API keys),
// but the idempotent ingest described in report §5 Integrations Module / pseudocode is implemented for real:
// each demo activity gets a stable provider_activityId composite key so re-syncing never duplicates logs. ----
const DEMO_ACTIVITIES = p => [{ id: "a1", min: 42, rpe: 6 }, { id: "a2", min: 55, rpe: 7 }, { id: "a3", min: 30, rpe: 5 }].map(a => ({ ...a, compositeId: `${p}_${a.id}` }));
app.post("/api/wearable/sync", auth, (req, res) => {
  const provider = req.body.provider || "strava", acts = DEMO_ACTIVITIES(provider);
  let added = 0;
  for (const a of acts) {
    if (db.synced.find(s => s.uid === req.uid && s.compositeId === a.compositeId)) continue; // SKIPPED, already ingested
    db.logs.push({ uid: req.uid, t: now_minus(added), min: a.min, rpe: a.rpe, type: "wearable:" + provider, load: a.min * a.rpe });
    db.synced.push({ uid: req.uid, compositeId: a.compositeId, t: Date.now() });
    added++;
  }
  save(); res.json({ status: "SUCCESS", imported: added, skipped: acts.length - added, acwr: acwr(req.uid) });
});
function now_minus(n) { return Date.now() - n * 36e5; }

// ---- Android Health Connect bridge ----
// The browser cannot read Android Health Connect directly. AgeisFit's companion
// Android app reads Health Connect on-device and posts the selected metrics here.
app.post("/api/healthconnect/pair", auth, (req, res) => {
  db.healthPairs = db.healthPairs.filter(p => p.expiresAt > Date.now() && p.uid !== req.uid);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.healthPairs.push({ uid: req.uid, code, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60e3, usedAt: null });
  save();
  res.json({ code, expiresAt: Date.now() + 10 * 60e3, message: "Enter this code in the AgeisFit Android app." });
});
app.get("/api/healthconnect/status", auth, (req, res) => {
  const row = mine("healthData", req.uid).sort((a,b) => b.syncedAt - a.syncedAt)[0] || null;
  res.json({ connected: !!row, lastSync: row?.syncedAt || null, data: row ? { steps: row.steps, calories: row.calories, avgHeartRate: row.avgHeartRate } : null });
});
app.post("/api/healthconnect/sync", async (req, res) => {
  const { code, steps = 0, calories = 0, avgHeartRate = null, startTime = null, endTime = null, device = "Android" } = req.body || {};
  const pair = db.healthPairs.find(p => p.code === String(code || "") && p.expiresAt > Date.now());
  if (!pair) return res.status(401).json({ error: "Invalid or expired pairing code. Generate a new code in AgeisFit Devices." });
  const clean = { uid: pair.uid, steps: Math.max(0, Number(steps) || 0), calories: Math.max(0, Number(calories) || 0), avgHeartRate: avgHeartRate == null ? null : Math.max(0, Number(avgHeartRate) || 0), startTime, endTime, device, syncedAt: Date.now() };
  db.healthData = db.healthData.filter(x => x.uid !== pair.uid);
  db.healthData.push(clean);
  pair.usedAt = Date.now();
  save();
  res.json({ ok: true, syncedAt: clean.syncedAt, data: { steps: clean.steps, calories: clean.calories, avgHeartRate: clean.avgHeartRate } });
});

// ---- cart (Connect & Shopping Module) ----
app.get("/api/cart", auth, (req, res) => res.json(mine("carts", req.uid)));
app.post("/api/cart", auth, (req, res) => { db.carts.push({ uid: req.uid, id: id(), name: req.body.name, price: req.body.price, source: req.body.source, t: Date.now() }); save(); res.json(mine("carts", req.uid)); });
app.delete("/api/cart/:id", auth, (req, res) => { db.carts = db.carts.filter(c => !(c.uid === req.uid && c.id === req.params.id)); save(); res.json(mine("carts", req.uid)); });

app.use(express.static(path.join(dir, "client")));

// Real price comparison: Google Shopping (India) -> sorted lowest price first
app.get("/api/prices", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  if (!KEY) {
    const e = encodeURIComponent(q);
    return res.json({ noKey: true, results: [
      { source: "Amazon.in", link: `https://www.amazon.in/s?k=${e}&s=price-asc-rank` },
      { source: "Flipkart", link: `https://www.flipkart.com/search?q=${e}&sort=price_asc` },
      { source: "Decathlon", link: `https://www.decathlon.in/search?Ntt=${e}` },
      { source: "Myntra", link: `https://www.myntra.com/${e}?sort=price_asc` }] });
  }
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({ engine: "google_shopping", q, gl: "in", hl: "en", api_key: KEY });
    const j = await (await fetch(u)).json();
    const results = (j.shopping_results || [])
      .filter(r => r.extracted_price)
      .map(r => ({ title: r.title, price: r.extracted_price, priceText: r.price, source: r.source,
                   link: r.product_link || r.link, thumb: r.thumbnail }))
      .sort((a, b) => a.price - b.price);
    res.json({ results });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgeisFit running -> http://localhost:${PORT}`));