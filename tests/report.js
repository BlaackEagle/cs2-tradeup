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
if (pr.tradeit) {
  const t = pr.tradeit;
  console.log(`  ${t.label.padEnd(24)} ${t.ok ? "OK " : t.stale ? "ANC" : "KO "} ${String(t.count).padStart(5)} Coverts` +
              `${t.error ? "  (" + t.error.slice(0, 60) + ")" : ""}`);
  // exemple : prix d'echange / prix de marche d'un Covert (attendu ~1,8)
  const h = "AK-47 | The Empress (Field-Tested)";
  const it = pr.items[h] || {};
  const mk = ["sk", "cf", "dm", "st"].map((k) => it[k] && it[k][0]).filter(Boolean);
  if (it.tt && mk.length) console.log(`    ${h} : echange ${it.tt[0].toFixed(2)} / marche ${Math.min(...mk).toFixed(2)} = x${(it.tt[0] / Math.min(...mk)).toFixed(3)}`);
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

// Stock tradeit (donnees publiques de la boutique) : meilleurs contrats au taux
// estime du site, comme les voit un visiteur sans inventaire deverrouille.
const tf = path.join(dir, "tradeit.json");
if (fs.existsSync(tf)) {
  const t = JSON.parse(fs.readFileSync(tf));
  const usd = (pr.fx && pr.fx.USD_EUR) || 0.86;
  const listings = {}, ratios = [];
  let n = 0;
  for (const [h, offers] of Object.entries(t.items || {})) {
    listings[h] = offers.flatMap((o) => o.f.map((f) => [f, (o.p / 100) * usd]));
    n += offers.reduce((s, o) => s + o.n, 0);
    const q = m.quote(h);
    if (q && q.price >= 1 && offers.length) ratios.push(Math.min(...offers.map((o) => o.p)) / 100 * usd / q.price);
  }
  ratios.sort((a, b) => a - b);
  const med = ratios[ratios.length >> 1];
  const rate = 1 / (0.92 * med);
  console.log(`\n=== stock tradeit : ${n} items, ${Object.keys(t.items || {}).length} skins et usures, ` +
              `releve il y a ${ageMin(t.updated_at)} min${t.complete ? "" : " (PARTIEL)"} ===`);
  if (ratios.length < 10) console.log("  pas assez de prix de marche pour estimer le taux d'echange");
  else console.log(`  echange / marche median x${med.toFixed(3)} sur ${ratios.length} Coverts -> taux estime ${rate.toFixed(3)}`);
  for (const st of ratios.length < 10 ? [] : [false, true]) {
    const t0 = Date.now();
    const list = m.stockContracts({ listings, rate, st, fillers: 2 });
    console.log(`  ${st ? "StatTrak" : "normal"} : ${list.filter((r) => r.profit > 0).length}/${list.length} caisses rentables en moyenne (${Date.now() - t0} ms)`);
    for (const r of list.slice(0, 3)) {
      console.log(`    ${r.case}${r.fillers ? ` + ${r.fillers} complement(s)` : ""} : profit ${money(r.profit)} (${(r.roi * 100).toFixed(1)} %), ` +
                  `cede ${money(r.cost)}, chance ${(r.pWin * 100).toFixed(1)} %`);
      console.log(`       ${r.inputs.map((x) => `${x.hash} ${x.float.toFixed(4)}`).join(" + ")}`);
    }
  }
}
