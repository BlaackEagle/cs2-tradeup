// Tests du moteur : node tests/engine.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const E = require(path.join(__dirname, "..", "site", "engine.js"));

let passed = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;   // ONLY=stock : sous-ensemble
function test(name, fn) {
  if (only && !only.test(name)) return;
  try { fn(); passed++; console.log("ok  -", name); }
  catch (e) { console.log("ECHEC -", name, "\n     ", e.message); process.exitCode = 1; }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), `${msg || ""} attendu ${b}, obtenu ${a}`);

// ------------------------------------------------------------------ catalogue jouet
const WEARS = [["Factory New", 0, 0.07], ["Minimal Wear", 0.07, 0.15], ["Field-Tested", 0.15, 0.38],
               ["Well-Worn", 0.38, 0.45], ["Battle-Scarred", 0.45, 1]];
const allW = WEARS.map((w) => w[0]);
const toy = {
  wears: WEARS,
  coverts: {
    "AK | A": { min: 0, max: 1, st: true, wears: allW },
    "P2 | B": { min: 0, max: 0.5, st: true, wears: allW.slice(0, 4) },
    "M4 | C": { min: 0, max: 1, st: true, wears: allW },
  },
  golds: {
    "★ K | Doppler": { min: 0, max: 0.08, st: true, kind: "knife", wears: ["Factory New", "Minimal Wear"], phases: ["Phase 1", "Ruby"] },
    "★ K | Rust": { min: 0.4, max: 1, st: true, kind: "knife", wears: ["Well-Worn", "Battle-Scarred"], phases: [] },
    "★ G | Vice": { min: 0.06, max: 0.8, st: false, kind: "glove", wears: allW, phases: [] },
  },
  collections: [
    { case: "Caisse 1", hash: "Caisse 1", inputs: ["AK | A", "P2 | B"], pool: [["★ K | Doppler", 2], ["★ K | Rust", 1]] },
    { case: "Caisse 2", hash: "Caisse 2", inputs: ["M4 | C"], pool: [["★ K | Doppler", 2], ["★ K | Rust", 1], ["★ G | Vice", 1]] },
  ],
};
function px(map) {
  const items = {};
  for (const [h, p] of Object.entries(map)) items[h] = { sk: [p, 10] };
  return { items, sources: { sk: { label: "Skinport" } }, order: ["sk"], fx: { EUR: 0.9 } };
}
const prices = px({
  "AK | A (Battle-Scarred)": 100, "AK | A (Field-Tested)": 150, "AK | A (Factory New)": 400,
  "P2 | B (Well-Worn)": 90, "P2 | B (Factory New)": 300,
  "M4 | C (Battle-Scarred)": 80, "M4 | C (Minimal Wear)": 200,
  "★ K | Doppler (Factory New)": 1000, "★ K | Doppler (Minimal Wear)": 800,
  "★ K | Rust (Well-Worn)": 150, "★ K | Rust (Battle-Scarred)": 120,
  "★ G | Vice (Battle-Scarred)": 300, "★ G | Vice (Field-Tested)": 600,
  "Caisse 1": 2, "Caisse 2": 1,
});

test("noms de marche (StatTrak, vanilla, usure)", () => {
  assert.strictEqual(E.hashName("★ Butterfly Knife | Doppler", "Factory New", true), "★ StatTrak™ Butterfly Knife | Doppler (Factory New)");
  assert.strictEqual(E.hashName("AK-47 | Bloodsport", "Field-Tested", true), "StatTrak™ AK-47 | Bloodsport (Field-Tested)");
  assert.strictEqual(E.hashName("★ Karambit", null, true), "★ StatTrak™ Karambit");
  assert.strictEqual(E.hashName("★ Karambit", null, false), "★ Karambit");
});

test("pool : une finition = une chance, ou une phase = une chance", () => {
  const m = E.create(toy, prices, { fee: 0 });
  assert.deepStrictEqual(m.poolOf(toy.collections[0], false).map((o) => o.w), [0.5, 0.5]);
  const e = E.create(toy, prices, { fee: 0, phaseMode: "entries" });
  assert.deepStrictEqual(e.poolOf(toy.collections[0], false).map((o) => o.w), [2 / 3, 1 / 3]);
  // StatTrak : les gants sortent du pool
  assert.strictEqual(m.poolOf(toy.collections[1], true).length, 2);
});

test("achat direct = moins cher parmi les usures autorisees", () => {
  const m = E.create(toy, prices, { fee: 0 });
  const r = m.analyze("★ K | Doppler", { minWear: "any" });
  assert.strictEqual(r.buy.cost, 800);
  const fn = m.analyze("★ K | Doppler", { minWear: "Factory New" });
  assert.strictEqual(fn.buy.cost, 1000);
});

const { reference } = require("./reference.js");

test("optimiseur = recherche exhaustive (sans contrainte d'usure)", () => {
  const m = E.create(toy, prices, { fee: 2 });
  const r = m.analyze("★ K | Doppler", { minWear: "any" });
  const tu = r.methods.find((x) => x.optimal);
  near(tu.expected, reference(toy, prices, "★ K | Doppler", { fee: 2, lim: null }), 1e-6, "cout attendu");
});

test("optimiseur = recherche exhaustive (cible FN obligatoire)", () => {
  const m = E.create(toy, prices, { fee: 2 });
  const r = m.analyze("★ K | Doppler", { minWear: "Factory New" });
  const tu = r.methods.find((x) => x.optimal);
  near(tu.expected, reference(toy, prices, "★ K | Doppler", { fee: 2, lim: 0.07 }), 1e-6, "cout attendu FN");
  assert.strictEqual(tu.targetWear, "Factory New");
  assert.ok(tu.targetFloatSup <= 0.07 + 1e-12, "float garanti FN");
});

test("frontiere d'usure : 4 MW (< 0.15) + 1 input < 0.10 donne un FN garanti", () => {
  // x < (4 x 0.15 + 0.10) / 5 = 0.14 -> float < 0.07 sur une plage 0-0.5 : FN
  const cat = {
    wears: WEARS,
    coverts: { "A | a": { min: 0, max: 1, st: false, wears: allW }, "B | b": { min: 0, max: 0.7, st: false, wears: allW } },
    golds: { "★ T | t": { min: 0, max: 0.5, st: false, kind: "knife", wears: allW, phases: [] } },
    collections: [{ case: "K", hash: "K", inputs: ["A | a", "B | b"], pool: [["★ T | t", 1]] }],
  };
  const p = px({ "A | a (Minimal Wear)": 10, "B | b (Factory New)": 20, "A | a (Factory New)": 100,
                 "★ T | t (Factory New)": 500, "★ T | t (Minimal Wear)": 300 });
  const tu = E.create(cat, p, { fee: 0 }).analyze("★ T | t", { minWear: "Factory New" }).methods.find((x) => x.optimal);
  assert.strictEqual(tu.cost, 4 * 10 + 20);
  assert.strictEqual(tu.targetWear, "Factory New");
  near(tu.targetFloatSup, 0.07, 1e-12, "borne de sortie");
});

test("calcul a la main : 5x M4 BS de Caisse 2", () => {
  // x = 1 -> Doppler 0.08 (MW, 800), Rust 1.0 (BS, 120), Vice 0.80 (BS, 300)
  // P(Doppler) = 1/3 ; autres = (120 + 300)/3 = 140 ; cout = 400
  // cout attendu = (400 - 140) / (1/3) = 780
  const solo = { ...toy, collections: [toy.collections[1]] };
  const m = E.create(solo, prices, { fee: 0 });
  const r = m.analyze("★ K | Doppler", { minWear: "any" });
  const tu = r.methods.find((x) => x.optimal);
  assert.strictEqual(tu.cost, 400);
  near(tu.p, 1 / 3, 1e-12, "P");
  near(tu.othersValue, 140, 1e-9, "revente autres");
  near(tu.expected, 780, 1e-9, "cout attendu");
  assert.strictEqual(tu.targetWear, "Minimal Wear");
});

test("formule brute vs normalisee sur un input a plage etroite", () => {
  // P2 | B (0-0.5) en WW : float max 0.45 -> position normalisee 0.9, brute 0.45
  const solo = { ...toy, collections: [{ ...toy.collections[0], inputs: ["P2 | B"] }] };
  const only = px({ "P2 | B (Well-Worn)": 90, "★ K | Doppler (Factory New)": 1000, "★ K | Doppler (Minimal Wear)": 800,
                    "★ K | Rust (Battle-Scarred)": 120, "★ K | Rust (Well-Worn)": 150 });
  const n = E.create(solo, only, { fee: 0 }).analyze("★ K | Doppler", {}).methods.find((x) => x.optimal);
  const r = E.create(solo, only, { fee: 0, floatMode: "raw" }).analyze("★ K | Doppler", {}).methods.find((x) => x.optimal);
  near(n.targetFloatSup, 0.9 * 0.08, 1e-12, "normalisee");
  near(r.targetFloatSup, 0.45 * 0.08, 1e-12, "brute");
  assert.strictEqual(n.targetWear, "Minimal Wear");
  assert.strictEqual(r.targetWear, "Factory New");
});

test("StatTrak : pas de gants, inputs StatTrak", () => {
  const p2 = px({ "StatTrak™ M4 | C (Battle-Scarred)": 90, "★ StatTrak™ K | Doppler (Minimal Wear)": 900,
                  "★ StatTrak™ K | Rust (Battle-Scarred)": 130 });
  const m = E.create(toy, p2, { fee: 0 });
  const r = m.analyze("★ K | Doppler", { st: true });
  const tu = r.methods.find((x) => x.optimal);
  assert.ok(tu.inputs.every((k) => k.hash.startsWith("StatTrak™ ")));
  assert.ok(!tu.outcomes.some((o) => o.name.includes("Vice")), "pas de gants en StatTrak");
  near(tu.p, 0.5, 1e-12, "1 chance sur 2 sans les gants");
});

test("ouverture de caisse : 0,26 % x part du pool", () => {
  const m = E.create(toy, prices, { fee: 0 });
  const r = m.analyze("★ K | Doppler", {});
  const u = r.methods.find((x) => x.kind === "unbox" && x.case === "Caisse 1");
  near(u.p, 0.0026 / 2, 1e-15, "P ouverture");
  near(u.expected, (2 + 2.49) / (0.0026 / 2), 1e-6, "cout");
});

test("float impossible a garantir -> note explicative", () => {
  // Gants FN : float < 0.07 sur une plage 0.06-0.80 => position moyenne < 0.0135,
  // impossible avec des inputs achetes par palier (FN = jusqu'a 0.07 de position)
  const m = E.create(toy, prices, { fee: 0 });
  const r = m.analyze("★ G | Vice", { minWear: "Factory New" });
  assert.ok(!r.methods.some((x) => x.kind === "tradeup"));
  assert.ok(r.notes.some((n) => n.kind === "float" && Math.abs(n.xNeeded - 0.01 / 0.74) < 1e-12));
});

// ----------------------------------------------------------- donnees reelles
test("donnees reelles : BFK Doppler (Spectrum 1 et 2)", () => {
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  const m = E.create(cat, pr, { fee: 2 });
  const t0 = Date.now();
  const r = m.analyze("★ Butterfly Knife | Doppler", {});
  const ms = Date.now() - t0;
  assert.deepStrictEqual(r.cases.sort(), ["Spectrum 2 Case", "Spectrum Case"]);
  const tu = r.methods.find((x) => x.optimal);
  assert.ok(tu, "un trade-up est propose");
  near(tu.p, 1 / 30, 1e-12, "1 finition sur 30");
  const ent = E.create(cat, pr, { fee: 2, phaseMode: "entries" }).analyze("★ Butterfly Knife | Doppler", {});
  near(ent.methods.find((x) => x.optimal).p, 7 / 60, 1e-12, "7 entrees sur 60");
  console.log(`      contrat ${tu.cost.toFixed(2)} $, cout attendu ${tu.expected.toFixed(0)} $, ` +
              `inputs: ${tu.inputs.map((k) => k.n + "x " + k.hash).join(" + ")} (${ms} ms)`);
});

test("donnees reelles : la valeur des autres golds ne monte jamais avec le float", () => {
  // c'est la propriete qui rend l'elagage de l'optimiseur exact
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  const m = E.create(cat, pr, { fee: 2 });
  let curves = 0;
  for (const st of [false, true]) {
    for (const col of cat.collections) {
      const pool = m.poolOf(col, st);
      if (!pool.length) continue;
      const target = pool[0].name;
      const r = m.analyze(target, { st });
      void r;
      // on rejoue la courbe sur une grille fine via l'API publique
      let prev = Infinity;
      for (let i = 0; i <= 400; i++) {
        const x = i / 400;
        let v = 0;
        for (const o of pool) {
          if (o.name === target) continue;
          const at = m.goldAt(o.name, x, st);
          if (at.value != null) v += o.w * at.value;
        }
        assert.ok(v <= prev + 1e-9, `${col.case} st=${st} : valeur ${v} > ${prev} a x=${x}`);
        prev = v;
      }
      curves++;
    }
  }
  console.log(`      ${curves} courbes verifiees`);
});

test("donnees reelles : optimiseur elague = recherche exhaustive", () => {
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  // golds presents dans 1 a 3 caisses : assez petits pour l'exhaustif
  const names = Object.keys(cat.golds).filter((n) => {
    const k = cat.collections.filter((c) => c.pool.some(([x]) => x === n)).length;
    return k >= 1 && k <= 3;
  });
  let checked = 0, pick = 0;
  for (const name of names) {
    if (pick++ % 7) continue;                    // un sur sept pour rester rapide
    for (const [st, minWear, lim] of [[false, "any", null], [true, "any", null], [false, "Factory New", 0.07]]) {
      const g = cat.golds[name];
      if (st && !g.st) continue;
      if (lim != null && !g.wears.includes("Factory New")) continue;
      const tu = E.create(cat, pr, { fee: 2 }).analyze(name, { st, minWear }).methods.find((x) => x.optimal);
      const ref = reference(cat, pr, name, { fee: 2, lim: g.wears.length ? lim : null, st });
      if (!isFinite(ref)) { assert.ok(!tu, `${name} : reference vide mais moteur ${tu && tu.expected}`); continue; }
      assert.ok(tu, `${name} (st=${st}, ${minWear}) : aucun contrat alors que la reference en trouve`);
      near(tu.expected, ref, 1e-6 * Math.max(1, Math.abs(ref)), `${name} st=${st} ${minWear}`);
      checked++;
    }
  }
  console.log(`      ${checked} optimums verifies contre la recherche exhaustive`);
});

test("donnees reelles : tous les golds s'analysent sans erreur", () => {
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  let slow = 0, worst = 0, n = 0;
  for (const st of [false, true]) {
    const m = E.create(cat, pr, { fee: 2 });
    for (const name of Object.keys(cat.golds)) {
      if (st && !cat.golds[name].st) continue;
      const t0 = Date.now();
      const r = m.analyze(name, { st, minWear: "any" });
      const ms = Date.now() - t0;
      worst = Math.max(worst, ms); if (ms > 300) slow++;
      for (const x of r.methods) assert.ok(isFinite(x.expected), `${name} ${x.label} non fini`);
      n++;
    }
  }
  console.log(`      ${n} analyses, la plus lente ${worst} ms, ${slow} au-dessus de 300 ms`);
});

// ------------------------------------------------- contrat compose a la main
test("evaluate : calcul a la main, floats exacts", () => {
  // 5x AK | A a 0.20 (plage 0-1) -> x = 0.20, palier FT (150 $ piece) = 750 $
  // Doppler 0-0.08 -> 0.016 FN (1000 $) ; Rust 0.4-1 -> 0.52 BS (revente 120 $)
  // 1 chance sur 2 chacun : EV = 560 $, profit -190 $, ROI -25.3 %, gain 50 %
  const m = E.create(toy, prices, { fee: 0 });
  const r = m.evaluate(Array(5).fill({ name: "AK | A", float: 0.2 }));
  assert.ok(r.complete && !r.errors.length, r.errors.join(" "));
  assert.strictEqual(r.cost, 750);
  const d = r.outcomes.find((o) => o.name === "★ K | Doppler");
  const ru = r.outcomes.find((o) => o.name === "★ K | Rust");
  near(d.p, 0.5); near(ru.p, 0.5);
  assert.strictEqual(d.wear, "Factory New"); near(d.float, 0.016, 1e-12);
  assert.strictEqual(ru.wear, "Battle-Scarred"); near(ru.float, 0.52, 1e-12);
  near(r.ev, 560, 1e-9); near(r.profit, -190, 1e-9); near(r.roi, 560 / 750 - 1, 1e-12);
  near(r.pWin, 0.5, 1e-12);
  assert.strictEqual(r.best.name, "★ K | Doppler");
});

test("evaluate : contrat mixte, prix impose, frais de revente", () => {
  // 3 inputs Caisse 1 + 2 inputs Caisse 2 : Doppler = 0.6*1/2 + 0.4*1/3
  const m = E.create(toy, prices, { fee: 10 });
  const r = m.evaluate([
    { name: "AK | A", wear: "Battle-Scarred" }, { name: "AK | A", wear: "Battle-Scarred" },
    { name: "P2 | B", wear: "Well-Worn", price: 50 },
    { name: "M4 | C", wear: "Battle-Scarred" }, { name: "M4 | C", wear: "Battle-Scarred" },
  ]);
  assert.strictEqual(r.cost, 100 + 100 + 50 + 80 + 80);
  near(r.outcomes.find((o) => o.name === "★ K | Doppler").p, 0.6 / 2 + 0.4 / 3, 1e-12);
  near(r.outcomes.find((o) => o.name === "★ G | Vice").p, 0.4 / 3, 1e-12);
  const tot = r.outcomes.reduce((s, o) => s + o.p, 0);
  near(tot, 1, 1e-12);
  for (const o of r.outcomes) if (o.net != null) near(o.net, o.value * 0.9, 1e-9);
});

test("evaluate : incomplet, StatTrak impossible", () => {
  const m = E.create(toy, prices, { fee: 0 });
  const part = m.evaluate([{ name: "AK | A", wear: "Field-Tested" }]);
  assert.ok(!part.complete && part.ev == null && part.outcomes.length === 2);
  const glovesOnly = { ...toy, collections: [{ case: "Gants", hash: "Gants", inputs: ["M4 | C"], pool: [["★ G | Vice", 1]] }] };
  const st = E.create(glovesOnly, prices, { fee: 0 }).evaluate(Array(5).fill({ name: "M4 | C", wear: "Battle-Scarred" }), { st: true });
  assert.ok(st.errors.some((e) => /gants/.test(e)), "erreur gants en StatTrak");
  assert.ok(st.ev == null);
});

// Reference : meilleur profit d'une caisse par enumeration complete, sans elagage
function refBestProfit(cat, pr, ci, st, fee, extra) {
  const col = cat.collections[ci];
  const sub = { ...cat, collections: [col] };
  const m = E.create(sub, pr, Object.assign({ fee }, extra));
  const cands = [];
  for (const name of col.inputs) {
    const sk = cat.coverts[name];
    if (st && !sk.st) continue;
    for (const w of sk.wears) if (m.quote(E.hashName(name, w, st))) cands.push({ name, wear: w });
  }
  let best = -Infinity;
  const n = cands.length;
  for (let a = 0; a < n; a++) for (let b = a; b < n; b++) for (let c = b; c < n; c++)
    for (let d = c; d < n; d++) for (let e = d; e < n; e++) {
      const r = m.evaluate([a, b, c, d, e].map((i) => cands[i]), { st });
      if (r.profit != null && r.profit > best) best = r.profit;
    }
  return best;
}

test("meilleurs contrats = enumeration complete (jouet)", () => {
  const m = E.create(toy, prices, { fee: 2 });
  for (const r of m.bestContracts({})) {
    const ci = toy.collections.findIndex((c) => c.case === r.case);
    near(r.profit, refBestProfit(toy, prices, ci, false, 2), 1e-9, r.case);
  }
});

test("donnees reelles : meilleurs contrats = enumeration complete", () => {
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  let checked = 0;
  for (const st of [false, true]) {
    const list = E.create(cat, pr, { fee: 2 }).bestContracts({ st });
    for (const r of list.slice(0, 8)) {
      const ci = cat.collections.findIndex((c) => c.case === r.case);
      near(r.profit, refBestProfit(cat, pr, ci, st, 2), 1e-6 * Math.max(1, Math.abs(r.profit)), `${r.case} st=${st}`);
      near(r.ev - r.cost, r.profit, 1e-9, "profit = EV - cout");
      checked++;
    }
  }
  console.log(`      ${checked} meilleurs contrats verifies contre l'enumeration complete`);
});

test("donnees reelles : evaluate = optimiseur sur le contrat retenu", () => {
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  const m = E.create(cat, pr, { fee: 2 });
  const tu = m.analyze("★ Butterfly Knife | Doppler", {}).methods.find((x) => x.optimal);
  const inputs = [];
  for (const k of tu.inputs) for (let i = 0; i < k.n; i++) inputs.push({ name: k.name, wear: k.wear });
  const r = m.evaluate(inputs);
  near(r.cost, tu.cost, 1e-9, "cout");
  near(r.ev, tu.ev, 1e-9, "valeur attendue");
  near(r.outcomes.find((o) => o.name === "★ Butterfly Knife | Doppler").p, tu.p, 1e-12, "chance de la cible");
});

test("prix personnalises : achat et valeur des golds (mode tradeit)", () => {
  const market = E.create(toy, prices, {});
  const buy = (h) => { const q = market.quote(h); return q ? { price: q.price * 2, src: "ti" } : null; };
  const val = (h) => { const it = prices.items[h]; return it ? { price: it.sk[0] * 1.5, src: "ti", est: h.includes("Rust") } : null; };
  const opts = { fee: 0, quote: buy, valueQuote: val };
  const m = E.create(toy, prices, opts);
  // 5x AK | A a 0.20 : FT a 150 x 2 = 300 piece ; Doppler FN 1000 x 1.5, Rust BS 120 x 1.5
  const r = m.evaluate(Array(5).fill({ name: "AK | A", float: 0.2 }));
  assert.strictEqual(r.cost, 1500);
  near(r.ev, (1500 + 180) / 2, 1e-9, "valeur moyenne");
  assert.ok(r.outcomes.find((o) => o.name === "★ K | Rust").est, "valeur estimee signalee");
  assert.ok(!r.outcomes.find((o) => o.name === "★ K | Doppler").est);
  near(m.analyze("★ K | Doppler", {}).buy.cost, 800 * 2, 1e-9, "achat direct au prix personnalise");
  for (const b of m.bestContracts({})) {
    const ci = toy.collections.findIndex((c) => c.case === b.case);
    near(b.profit, refBestProfit(toy, prices, ci, false, 0, opts), 1e-9, b.case);
  }
});

// ------------------------------------------------- stock reel (items precis)
function rng(seed) {                     // mulberry32 : tirages reproductibles
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** stock aleatoire : par usure, quelques items au meme prix (une pile) ou a des prix differents */
function randomStock(cat, rand, o) {
  const out = {};
  for (const name of Object.keys(cat.coverts)) {
    const sk = cat.coverts[name];
    for (const st of o.st ? [false, true] : [false]) {
      if (st && !sk.st) continue;
      for (const w of sk.wears) {
        if (rand() < (o.skip || 0.3)) continue;
        const [, lo, hi] = WEARS.find((x) => x[0] === w);
        const a = Math.max(lo, sk.min), b = Math.min(hi, sk.max);
        const base = (o.price ? o.price(E.hashName(name, w, st)) : null) || 20 + rand() * 200;
        const n = 1 + Math.floor(rand() * (o.depth || 3));
        const pile = rand() < 0.6;
        out[E.hashName(name, w, st)] = Array.from({ length: n }, () =>
          [a + rand() * (b - a) * 0.999, Math.round((pile ? base : base * (0.8 + rand() * 0.5)) * 100) / 100]);
      }
    }
  }
  return out;
}

/** reference : tous les ensembles de 5 items distincts, evalues un par un */
function bruteStock(cat, pr, listings, o) {
  const m = E.create(cat, pr, { fee: o.fee });
  const items = [];
  for (const col of cat.collections) {
    for (const name of col.inputs) {
      const sk = cat.coverts[name];
      if (o.st && !sk.st) continue;
      for (const w of sk.wears) {
        for (const [f, p] of listings[E.hashName(name, w, o.st)] || []) {
          items.push({ name, float: f, price: p * (o.rate || 1), trade: p, src: "stock", case: col.case });
        }
      }
    }
  }
  const need = 5 - (o.fillers || 0), budget = o.budget || Infinity;
  const best = {};
  let overall = -Infinity, combos = 0;
  const n = items.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const pick = [items[a], items[b], items[c], items[d], items[e]];
      if (pick.reduce((s, x) => s + x.price, 0) > budget) continue;
      const r = m.evaluate(pick, { st: o.st });
      if (r.profit == null) continue;
      combos++;
      if (r.profit > overall) overall = r.profit;
      const per = {};
      for (const x of pick) per[x.case] = (per[x.case] || 0) + 1;
      for (const [cs, k] of Object.entries(per)) {
        if (k >= need && !(best[cs] >= r.profit)) best[cs] = r.profit;
      }
    }
  return { best, overall, combos, n };
}

function checkStock(cat, pr, listings, o, label) {
  const got = E.create(cat, pr, { fee: o.fee }).stockContracts(Object.assign({ listings }, o));
  const ref = bruteStock(cat, pr, listings, o);
  const seen = new Set();
  for (const r of got) {
    seen.add(r.case);
    near(r.profit, ref.best[r.case], 1e-9, `${label} ${r.case}`);
    near(r.ev - r.cost, r.profit, 1e-9, "profit = EV - cout");
    assert.ok(r.inputs.filter((x) => x.case === r.case).length >= 5 - (o.fillers || 0), `${label} : caisse principale minoritaire`);
    if (o.budget) assert.ok(r.cost <= o.budget + 1e-9, `${label} : budget depasse`);
  }
  for (const cs of Object.keys(ref.best)) assert.ok(seen.has(cs), `${label} : ${cs} manquant`);
  if (isFinite(ref.overall)) near(got.overall.profit, ref.overall, 1e-9, `${label} meilleur global`);
  else assert.strictEqual(got.overall, null);
  return ref;
}

test("stock reel = enumeration complete (jouet, 24 tirages, melanges et budgets)", () => {
  let combos = 0, runs = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const rand = rng(seed);
    const st = seed % 4 === 0;
    const listings = randomStock(toy, rand, { st, skip: 0.25, depth: 3 });
    for (const fillers of [0, 1, 2]) {
      const o = { st, fee: 2, fillers, rate: seed % 3 ? 1 : 0.6 };
      const ref = checkStock(toy, prices, listings, o, `graine ${seed} complements ${fillers}`);
      combos += ref.combos; runs++;
      if (seed % 5 === 0 && isFinite(ref.overall)) {
        // budget serre : moitie du cout du meilleur contrat sans budget
        const free = E.create(toy, prices, { fee: 2 }).stockContracts(Object.assign({ listings }, o));
        checkStock(toy, prices, listings, Object.assign({}, o, { budget: free.overall.cost * 0.8 }), `graine ${seed} budget`);
      }
    }
  }
  console.log(`      ${runs} optimisations verifiees sur ${combos} contrats enumeres`);
});

test("stock reel : un complement d'une autre caisse peut battre le 100 %", () => {
  // Caisse H : couteau a 5000 en FN (float < 0.07 sur 0-0.08 => position < 0.875),
  // mais ses Coverts en stock sont hauts. Caisse L : Coverts bas et pas chers.
  const cat = {
    wears: WEARS,
    coverts: { "H | h": { min: 0, max: 1, st: false, wears: allW }, "L | l": { min: 0, max: 1, st: false, wears: allW } },
    golds: {
      "★ D | d": { min: 0, max: 0.08, st: false, kind: "knife", wears: ["Factory New", "Minimal Wear"], phases: [] },
      "★ R | r": { min: 0, max: 1, st: false, kind: "knife", wears: allW, phases: [] },
    },
    collections: [
      { case: "H", hash: "H", inputs: ["H | h"], pool: [["★ D | d", 1]] },
      { case: "L", hash: "L", inputs: ["L | l"], pool: [["★ R | r", 1]] },
    ],
  };
  const p = px({ "★ D | d (Factory New)": 5000, "★ D | d (Minimal Wear)": 1000,
                 "★ R | r (Factory New)": 900, "★ R | r (Battle-Scarred)": 100 });
  const listings = {
    "H | h (Battle-Scarred)": [[0.95, 150], [0.96, 150], [0.97, 150], [0.98, 150], [0.99, 150]],
    "L | l (Factory New)": [[0.01, 60], [0.02, 60]],
  };
  const m = E.create(cat, p, { fee: 0 });
  const pure = m.stockContracts({ listings }).find((r) => r.case === "H");
  const mix = m.stockContracts({ listings, fillers: 2 }).find((r) => r.case === "H");
  // 100 % H : x = 0.97 -> MW, EV 1000, profit 250.
  // 4 H + 1 L : x = (0.95+0.96+0.97+0.98+0.01)/5 = 0.774 -> D FN, EV 4/5 x 5000 + 1/5 x 100,
  // profit 3360 ; 3 H + 2 L (x = 0.582) ne rapporte que 2470.
  near(pure.ev, 1000, 1e-9, "100 % H");
  assert.strictEqual(mix.fillers, 1);
  near(mix.ev, 0.8 * 5000 + 0.2 * 100, 1e-9, "4 H + 1 L");
  near(mix.profit, 3360, 1e-9, "profit 4 H + 1 L");
  near(m.stockContracts({ listings, fillers: 2 }).overall.profit, 3360, 1e-9, "meilleur global");
  checkStock(cat, p, listings, { fee: 0, fillers: 2 }, "melange");
});

test("donnees reelles : stock simule, exact et rapide", () => {
  const dir = path.join(__dirname, "..", "site", "data");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
  const base = E.create(cat, pr, { fee: 2 });
  const price = (h) => { const q = base.quote(h); return q ? q.price * 1.8 : null; };
  let worst = 0, n = 0;
  for (const st of [false, true]) {
    const listings = randomStock(cat, rng(st ? 7 : 3), { st, skip: 0.2, depth: 8, price });
    const m = E.create(cat, pr, { fee: 2 });
    for (const fillers of [0, 2]) {
      const t0 = Date.now();
      const list = m.stockContracts({ listings, st, fillers, rate: 0.6 });
      const ms = Date.now() - t0;
      worst = Math.max(worst, ms); n++;
      assert.ok(list.length > 10, `peu de contrats (${list.length})`);
      for (const r of list) {
        near(r.ev - r.cost, r.profit, 1e-9, "profit = EV - cout");
        assert.ok(r.inputs.every((x) => x.exact && x.q.src === "stock"), "items precis");
        if (fillers === 0) assert.ok(!r.mixed, "100 % une caisse");
      }
      if (fillers === 2) {
        // le melange ne fait jamais moins bien que le 100 % de la meme caisse
        const pure = m.stockContracts({ listings, st, fillers: 0, rate: 0.6 });
        for (const r of pure) {
          const mx = list.find((x) => x.case === r.case);
          assert.ok(mx && mx.profit >= r.profit - 1e-9, `${r.case} : melange ${mx && mx.profit} < pur ${r.profit}`);
        }
        assert.ok(list.overall.profit >= list[0].profit - 1e-9, "meilleur global >= meilleur par caisse");
      }
      console.log(`      st=${st} complements=${fillers} : ${list.length} contrats, ${list.items} items utiles, ` +
                  `meilleur ${list[0].profit.toFixed(2)} (${ms} ms)`);
    }
    // exactitude sur de vraies caisses : enumeration complete d'un petit stock
    const small = randomStock(cat, rng(st ? 11 : 5), { st, skip: 0.5, depth: 2, price });
    const cs = cat.collections.filter((c) => c.inputs.length >= 2).slice(0, 4);
    const keep = {};
    for (const c of cs) for (const name of c.inputs) for (const w of cat.coverts[name].wears) {
      const h = E.hashName(name, w, st);
      if (small[h]) keep[h] = small[h];
    }
    const sub = { ...cat, collections: cs };
    checkStock(sub, pr, keep, { st, fee: 2, fillers: 2, rate: 0.6 }, `vraies caisses st=${st}`);
  }
  assert.ok(worst < 3000, `trop lent : ${worst} ms`);
});

console.log(`\n${passed} tests passes`);
