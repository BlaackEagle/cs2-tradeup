// Rapport lisible : ce que le site affiche, calcule avec le moteur du site sur
// les prix fraichement releves. Lance dans le workflow apres le releve.
//   node tests/report.js
"use strict";
const path = require("path");
const fs = require("fs");
const E = require(path.join(__dirname, "..", "site", "engine.js"));
const dir = path.join(__dirname, "..", "site", "data");
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
