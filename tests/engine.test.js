// Tests du moteur : node tests/engine.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const E = require(path.join(__dirname, "..", "site", "engine.js"));

let passed = 0;
function test(name, fn) {
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

console.log(`\n${passed} tests passes`);
