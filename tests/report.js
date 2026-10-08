// Rapport lisible : ce que le site affiche, calcule avec le moteur du site sur
// les prix fraichement releves. Lance dans le workflow apres le releve.
//   node tests/report.js
"use strict";
const path = require("path");
const fs = require("fs");
const E = require(path.join(__dirname, "..", "site", "engine.js"));
const dir = process.env.DATA_DIR || path.join(__dirname, "..", "site", "data");
const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));

const cur = pr.currency === "EUR" ? "€" : "$";
const money = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(2)} ${cur}`);
const pct = (p) => `${(p * 100).toFixed(3)} %`;
const ageMin = (iso) => (iso ? Math.round((Date.now() - new Date(iso)) / 60000) : null);

console.log(`devise ${pr.currency} | taux 1 $ = ${pr.fx && pr.fx.USD_EUR} € (${pr.fx && pr.fx.date})`);
for (const k of pr.order) {
  const s = pr.sources[k];
  const a = ageMin(s.updated_at);
  console.log(`  ${s.label.padEnd(24)} ${s.ok ? "OK " : s.stale ? "ANC" : "KO "} ${String(s.count).padStart(5)} prix` +
              `${a != null ? `, il y a ${a} min` : ""}${s.error ? "  (" + s.error.slice(0, 60) + ")" : ""}`);
}
// memes reglages que le site par defaut : sources live seulement
const m = E.create(cat, pr, { fee: 2, keyPrice: 2.49, sources: ["sk", "cf", "dm", "st"] });
const targets = process.argv.slice(2).length ? process.argv.slice(2)
  : ["★ Butterfly Knife | Doppler", "★ Karambit | Doppler", "★ M9 Bayonet | Fade", "★ Sport Gloves | Vice"];

for (const t of targets) {
  if (!cat.golds[t]) { console.log(`\n${t} : inconnu`); continue; }
  const r = m.analyze(t, { minWear: "any" });
  console.log(`\n=== ${t} ===`);
  const buy = r.buy;
  if (buy.best) {
    const all = buy.best.all.filter((x) => x.enabled).map((x) => `${x.src}=${x.price.toFixed(2)}`).join(" ");
    console.log(`  achat direct : ${money(buy.cost)} (${buy.best.hash}, ${buy.best.q.src}) [${all}]`);
  } else {
    console.log("  achat direct : aucune annonce live");
  }
  for (const x of r.methods.filter((x) => x.kind === "tradeup")) {
    console.log(`  ${x.label} : cout moyen ${money(x.expected)} | contrat ${money(x.cost)} | chance ${pct(x.p)} | ` +
                `revente autres ${money(x.othersValue)} | cible ${x.targetWear || "-"}`);
    console.log(`     inputs : ${x.inputs.map((k) => `${k.n}x ${k.hash} @ ${k.price.toFixed(2)} (${k.q.src})`).join(" + ")}`);
  }
  const best = r.methods.filter((x) => x.kind !== "unbox")[0];
  if (best) console.log(`  -> le moins cher : ${best.label}, ${money(best.expected)}`);
}

// Stock tradeit (donnees publiques de la boutique) : meilleurs contrats en
// monnaie d'echange, comme sur le site : Coverts a leur prix d'echange, golds
// a ce que tradeit en donne (estime quand tradeit n'en a pas en stock).
const tf = path.join(dir, "tradeit.json");
if (fs.existsSync(tf)) {
  const t = JSON.parse(fs.readFileSync(tf));
  const usd = (pr.fx && pr.fx.USD_EUR) || 0.86;
  const conv = (c) => (c / 100) * (pr.currency === "EUR" ? usd : 1);
  const listings = {}, cheapest = {};
  let n = 0;
  for (const [h, offers] of Object.entries(t.items || {})) {
    listings[h] = offers.flatMap((o) => (o.f || []).map((f) => [f, conv(o.p)]));
    if (offers.length) cheapest[h] = conv(Math.min(...offers.map((o) => o.p)));
    n += offers.reduce((s, o) => s + o.n, 0);
  }
  const golds = Object.fromEntries(Object.entries(t.golds || {}).map(([h, g]) => [h, { p: conv(g.p), u: g.u ? conv(g.u) : null }]));
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
  const share = med(Object.values(golds).filter((g) => g.u).map((g) => g.u / g.p));
  const k = med(Object.entries(golds).map(([h, g]) => { const q = m.quote(h); const u = g.u || (share && g.p * share);
    return q && q.price >= 5 && u ? u / q.price : null; }).filter(Boolean));
  const buy = (h) => (cheapest[h] ? { price: cheapest[h], src: "ti" } : golds[h] ? { price: golds[h].p, src: "ti" } : null);
  const value = (h) => {
    const g = golds[h];
    if (g && g.u) return { price: g.u, src: "ti" };
    if (g && share) return { price: g.p * share, src: "ti", est: true };
    const q = k ? m.quote(h) : null;
    return q ? { price: q.price * k, src: "ti", est: true } : null;
  };
  const ti = E.create(cat, pr, { fee: 0, quote: buy, valueQuote: value });
  const st = t.stats || {};
  console.log(`\n=== stock tradeit : ${n} items, ${Object.keys(t.items || {}).length} skins et usures, ` +
              `releve il y a ${ageMin(t.updated_at)} min ; floats lus pour ${st.with_floats}/${st.offers} piles, ` +
              `${st.requests} requetes dont ${st.http429} refusees (429) ===`);
  console.log(`  couteaux et gants : ${Object.keys(golds).length} avec un prix d'echange, ${st.golds_user} avec leur valeur d'echange ` +
              `(valeur / prix d'echange median ${share ? share.toFixed(3) : "-"}, valeur / marche median ${k ? k.toFixed(3) : "-"})`);
  for (const stt of [false, true]) {
    const t0 = Date.now();
    const list = ti.stockContracts({ listings, st: stt, fillers: 2 });
    console.log(`  ${stt ? "StatTrak" : "normal"} : ${list.filter((r) => r.profit > 0).length}/${list.length} caisses rentables en moyenne, en monnaie d'echange (${Date.now() - t0} ms)`);
    for (const r of list.slice(0, 3)) {
      const est = r.outcomes.filter((o) => o.est).length;
      console.log(`    ${r.case}${r.fillers ? ` + ${r.fillers} complement(s)` : ""} : profit ${money(r.profit)} (${(r.roi * 100).toFixed(1)} %), ` +
                  `cout ${money(r.cost)}, chance ${(r.pWin * 100).toFixed(1)} %${est ? `, ${est}/${r.outcomes.length} resultats estimes` : ""}`);
      console.log(`       ${r.inputs.map((x) => `${x.hash} ${x.float.toFixed(4)}`).join(" + ")}`);
    }
  }
}
