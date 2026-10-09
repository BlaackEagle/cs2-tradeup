// Analyse ponctuelle (branche temporaire) : contrat MP9 | Starlight Protector (MW)
// + M4A1-S | Cyrex (FN), de 0 a 5 Cyrex, aux prix d'un autre site, aux prix des
// marches et en prix d'echange tradeit (items precis du stock).
//   node scripts/contract_check.js DOSSIER_DONNEES
"use strict";
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "site", "engine.js"));
const dir = process.argv[2];
const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
const t = JSON.parse(fs.readFileSync(path.join(dir, "tradeit.json")));
const usd = pr.fx.USD_EUR, eur = (c) => (c / 100) * usd;
const f2 = (v) => (v == null || !isFinite(v) ? "-" : v.toFixed(2));
const pc = (p) => `${(p * 100).toFixed(1)} %`;
const SH = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
const S = "MP9 | Starlight Protector", C = "M4A1-S | Cyrex";
const isBfk = (n) => n.startsWith("★ Butterfly Knife");

// ------------------------------------------------ moteurs : marches (frais 0) et tradeit
const market = E.create(cat, pr, { fee: 0, sources: ["sk", "cf", "dm", "st"] });
const by = {}, listings = {}, golds = {};
for (const [h, offers] of Object.entries(t.items || {})) {
  by[h] = offers.filter((o) => o.p > 0 && o.n > 0).map((o) => ({ trade: eur(o.p), n: o.n, f: o.f || [] })).sort((a, b) => a.trade - b.trade);
  listings[h] = by[h].flatMap((o) => o.f.map((f) => [f, o.trade]));
}
for (const [h, g] of Object.entries(t.golds || {})) if (g.p > 0) golds[h] = { p: eur(g.p), u: g.u ? eur(g.u) : null };
const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const share = med(Object.values(golds).filter((g) => g.u).map((g) => g.u / g.p));
const k = med(Object.entries(golds).map(([h, g]) => { const q = market.quote(h), u = g.u || (share && g.p * share); return q && q.price >= 5 && u ? u / q.price : null; }).filter(Boolean));
const buy = (h) => (by[h] && by[h].length ? { price: by[h][0].trade, src: "ti" } : golds[h] ? { price: golds[h].p, src: "ti" } : null);
const value = (h) => { const g = golds[h]; if (g && g.u) return { price: g.u, src: "ti" }; if (g && share) return { price: g.p * share, src: "ti", est: true };
  const q = k ? market.quote(h) : null; return q ? { price: q.price * k, src: "ti", est: true } : null; };
const ti = E.create(cat, pr, { fee: 0, quote: buy, valueQuote: value });

function line(r, label) {
  if (!r || r.ev == null) { console.log(`  ${label} : non chiffrable`); return; }
  const pb = r.outcomes.filter((o) => isBfk(o.name)).reduce((s, o) => s + o.p, 0);
  const evB = r.outcomes.filter((o) => isBfk(o.name)).reduce((s, o) => s + o.p * (o.net || 0), 0);
  const est = r.outcomes.filter((o) => o.est).length;
  console.log(`  ${label.padEnd(26)} cout ${f2(r.cost).padStart(8)} | valeur moy. ${f2(r.ev).padStart(8)} | profit ${f2(r.profit).padStart(8)} (${pc(r.roi).padStart(7)}) | ` +
              `chance de profit ${pc(r.pWin).padStart(6)} | P(BFK) ${pc(pb).padStart(6)} | BFK moyen ${f2(pb ? evB / pb : null)} | x ${r.x.toFixed(4)}${est ? ` | ${est}/${r.outcomes.length} valeurs estimees` : ""}`);
}
function wears(r) {
  const w = {};
  for (const o of r.outcomes) { const key = o.wear ? SH[o.wear] : "sans usure"; w[key] = (w[key] || 0) + o.p; }
  return Object.entries(w).map(([a, b]) => `${a} ${pc(b)}`).join(", ");
}

// ------------------------------------------------ 1. le contrat de la capture et ses variantes
const fS = [0.1034, 0.1037, 0.1032, 0.1045, 0.1034];
const fC = [0.040, 0.040, 0.040, 0.040, 0.040];
const mk = (nC, priced) => fS.slice(0, 5 - nC).map((f) => ({ name: S, float: f, price: priced ? 52.43 : null }))
  .concat(fC.slice(0, nC).map((f) => ({ name: C, float: f, price: priced ? 149.22 : null })));
console.log("Prix du marche actuels (nos sources, EUR) : " +
  `${S} MW ${f2((market.quote(E.hashName(S, "Minimal Wear", false)) || {}).price)} ; ${C} FN ${f2((market.quote(E.hashName(C, "Factory New", false)) || {}).price)}`);
console.log("\n=== 1. Prix de la capture (52,43 € le Starlight MW, 149,22 € le Cyrex FN), golds aux prix des marches, sans frais ===");
for (let n = 0; n <= 5; n++) line(market.evaluate(mk(n, true)), `${n} Cyrex + ${5 - n} Starlight`);
const r1 = market.evaluate(mk(1, true));
console.log(`  usures obtenues (1 Cyrex) : ${wears(r1)}`);
console.log("  resultats du contrat de la capture (1 Cyrex + 4 Starlight) :");
for (const o of r1.outcomes.slice().sort((a, b) => (b.net || 0) - (a.net || 0))) {
  console.log(`     ${pc(o.p).padStart(6)}  ${(o.name + (o.wear ? ` (${SH[o.wear]} ${o.float.toFixed(4)})` : "")).padEnd(50)} ${f2(o.net).padStart(9)}  ${o.profit >= 0 ? "+" : ""}${f2(o.profit)}`);
}

console.log("\n=== 2. Memes floats, aux prix du marche actuels (nos sources), sans frais ===");
for (let n = 0; n <= 5; n++) line(market.evaluate(mk(n, false)), `${n} Cyrex + ${5 - n} Starlight`);

// ------------------------------------------------ 3. en prix d'echange tradeit, items precis du stock
console.log("\n=== 3. En prix d'echange tradeit, plus bas floats du stock ===");
const pile = (name, w) => (by[E.hashName(name, w, false)] || [])[0];
for (const [name, w] of [[S, "Minimal Wear"], [S, "Factory New"], [C, "Factory New"], [C, "Minimal Wear"]]) {
  const o = pile(name, w);
  console.log(`  pile ${name} (${SH[w]}) : ${o ? `${o.n} en stock a ${f2(o.trade)} €, floats ${o.f.slice(0, 5).map((x) => x.toFixed(4)).join(" ") || "pas encore lus"}` : "pas en stock"}`);
}
const sMW = pile(S, "Minimal Wear"), cFN = pile(C, "Factory New");
if (sMW && cFN && sMW.f.length >= 5 && cFN.f.length >= 1) {
  for (let n = 0; n <= Math.min(5, cFN.f.length); n++) {
    const items = sMW.f.slice(0, 5 - n).map((f) => ({ name: S, float: f, price: sMW.trade, src: "ti" }))
      .concat(cFN.f.slice(0, n).map((f) => ({ name: C, float: f, price: cFN.trade, src: "ti" })));
    line(ti.evaluate(items), `${n} Cyrex FN + ${5 - n} Starlight MW`);
  }
} else console.log("  pas assez d'items en stock avec floats connus pour ces variantes");

// ------------------------------------------------ 4. ce que l'optimiseur trouve avec ces deux caisses
console.log("\n=== 4. Optimiseur tradeit, stock Dreams & Nightmares + Operation Breakout (items precis) ===");
const two = { ...cat, collections: cat.collections.filter((c) => ["Dreams & Nightmares Case", "Operation Breakout Weapon Case"].includes(c.case)) };
const ti2 = E.create(two, pr, { fee: 0, quote: buy, valueQuote: value });
for (const fillers of [0, 2]) {
  const list = ti2.stockContracts({ listings, fillers });
  for (const r of list) {
    line(r, `${r.case.replace(" Weapon Case", "").replace(" Case", "")}${r.fillers ? ` + ${r.fillers} autre` : ""}`);
    console.log(`       ${r.inputs.map((x) => `${x.name.split(" | ")[1]} ${SH[x.wear]} ${x.float.toFixed(4)} (${f2(x.price)})`).join(" + ")}`);
  }
}
