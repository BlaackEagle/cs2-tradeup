// Analyse ponctuelle (branche temporaire) : obtenir un Butterfly Knife, n'importe
// lequel, par trade-up avec le stock tradeit, tout en monnaie d'echange.
//   node scripts/bfk_analysis.js DOSSIER_DONNEES
"use strict";
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "site", "engine.js"));

const dir = process.argv[2] || path.join(__dirname, "..", "site", "data");
const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
const t = JSON.parse(fs.readFileSync(path.join(dir, "tradeit.json")));
const usd = pr.fx.USD_EUR;                                   // 1 $ = usd €
const eur = (c) => (c / 100) * usd;                          // centimes de $ -> €
const fmt = (v) => (v == null || !isFinite(v) ? "-" : `${v.toFixed(2)} € (${(v / usd).toFixed(2)} $)`);
const pc = (p) => `${(p * 100).toFixed(1)} %`;
const SH = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
const ageMin = (iso) => (iso ? Math.round((Date.now() - new Date(iso)) / 60000) : null);

// ---------------------------------------------------- donnees tradeit, comme le site
const market = E.create(cat, pr, { fee: 2, sources: ["sk", "cf", "dm", "st"] });
const by = {}, listings = {}, golds = {};
for (const [h, offers] of Object.entries(t.items || {})) {
  by[h] = offers.filter((o) => o.p > 0 && o.n > 0)
    .map((o) => ({ trade: eur(o.p), n: o.n, f: o.f || [], hi: o.hi, at: o.at })).sort((a, b) => a.trade - b.trade);
  listings[h] = by[h].flatMap((o) => o.f.map((f) => [f, o.trade]));
}
for (const [h, g] of Object.entries(t.golds || {})) if (g.p > 0) golds[h] = { p: eur(g.p), u: g.u ? eur(g.u) : null, n: g.n };
const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const share = med(Object.values(golds).filter((g) => g.u).map((g) => g.u / g.p));
const k = med(Object.entries(golds).map(([h, g]) => {
  const q = market.quote(h), u = g.u || (share && g.p * share);
  return q && q.price >= 5 && u ? u / q.price : null;
}).filter(Boolean));
const buy = (h) => (by[h] && by[h].length ? { price: by[h][0].trade, src: "ti" } : golds[h] ? { price: golds[h].p, src: "ti" } : null);
const value = (h) => {
  const g = golds[h];
  if (g && g.u) return { price: g.u, src: "ti" };
  if (g && share) return { price: g.p * share, src: "ti", est: true };
  const q = k ? market.quote(h) : null;
  return q ? { price: q.price * k, src: "ti", est: true } : null;
};
const opts = { fee: 0, quote: buy, valueQuote: value };
const ti = E.create(cat, pr, opts);

console.log(`Donnees : stock tradeit releve il y a ${ageMin(t.updated_at)} min, ${(t.stats || {}).with_floats}/${(t.stats || {}).offers} piles avec floats, ` +
            `${Object.keys(golds).length} couteaux/gants avec prix d'echange dont ${Object.values(golds).filter((g) => g.u).length} avec valeur d'echange exacte. ` +
            `1 $ = ${usd} €. Valeur d'echange / prix d'echange median : ${share && share.toFixed(3)}.`);

// ---------------------------------------------------- caisses qui donnent un BFK
const isBfk = (n) => n.startsWith("★ Butterfly Knife");
const bfkCases = cat.collections.filter((c) => c.pool.some(([n]) => isBfk(n)));
console.log("\n=== Caisses qui donnent un Butterfly ===");
for (const c of bfkCases) {
  const p = ti.poolOf(c, false).filter((o) => isBfk(o.name)).reduce((s, o) => s + o.w, 0);
  console.log(`  ${c.case} : ${pc(p)} de BFK par input ; Coverts : ${c.inputs.join(", ")}`);
}

// ---------------------------------------------------- stock des Coverts Breakout
const breakout = cat.collections.find((c) => c.case === "Operation Breakout Weapon Case");
console.log("\n=== Stock tradeit des Coverts de l'Operation Breakout ===");
for (const st of [false, true]) {
  for (const name of breakout.inputs) {
    for (const w of cat.coverts[name].wears) {
      const h = E.hashName(name, w, st);
      for (const o of by[h] || []) {
        console.log(`  ${h.padEnd(44)} ${String(o.n).padStart(3)} en stock a ${fmt(o.trade)} ; floats ${o.f.length ? o.f.slice(0, 5).map((f) => f.toFixed(4)).join(" ") + (o.n > 5 ? ` ... ${o.hi.toFixed(4)}` : "") : "pas encore lus"}`);
      }
      if (!(by[h] || []).length) console.log(`  ${h.padEnd(44)}   - pas en stock`);
    }
  }
}

// ---------------------------------------------------- valeur des BFK Breakout
console.log("\n=== Butterfly de l'Operation Breakout chez tradeit (prix d'echange pour l'acheter / ce que tradeit t'en donne) ===");
const fins = breakout.pool.map(([n]) => n);
for (const st of [false, true]) {
  console.log(st ? "  -- StatTrak --" : "  -- normal --");
  for (const n of fins) {
    const g = cat.golds[n];
    const cells = (g.wears.length ? g.wears : [null]).map((w) => {
      const h = E.hashName(n, w, st), v = value(h), b = golds[h];
      return `${w ? SH[w] : "-"} ${b ? b.p.toFixed(0) : "?"}/${v ? (v.est ? "~" : "") + v.price.toFixed(0) : "?"}`;
    });
    console.log(`  ${n.replace("★ Butterfly Knife", "BFK").padEnd(26)} ${cells.join("  ")}`);
  }
}

// ---------------------------------------------------- contrats a BFK garanti
function show(r, label) {
  if (!r || r.ev == null) { console.log(`  ${label} : impossible`); return; }
  console.log(`\n  ${label}`);
  for (const x of r.inputs) {
    console.log(`     ${x.hash.padEnd(46)} float ${x.exact ? x.float.toFixed(6) : "< " + x.float.toFixed(2)}  ${fmt(x.price)}`);
  }
  const bfk = r.outcomes.filter((o) => isBfk(o.name)).reduce((s, o) => s + o.p, 0);
  console.log(`     cout ${fmt(r.cost)} | valeur moyenne (ce que tradeit t'en donne) ${fmt(r.ev)} | profit moyen ${fmt(r.profit)} (${pc(r.roi)}) | ` +
              `chance de profit ${pc(r.pWin)} | P(BFK) ${pc(bfk)} | x moyen ${r.x.toFixed(4)}`);
  const list = r.outcomes.slice().sort((a, b) => (b.net || 0) - (a.net || 0));
  for (const o of list) {
    console.log(`       ${pc(o.p).padStart(7)}  ${(o.name + (o.wear ? ` (${SH[o.wear]} ${o.float.toFixed(4)})` : "")).padEnd(52)} ${o.est ? "~" : " "}${fmt(o.net)}  ${o.profit == null ? "sans valeur connue (compte 0)" : `${o.profit >= 0 ? "+" : ""}${o.profit.toFixed(2)} €`}`);
  }
}

const tiB = E.create({ ...cat, collections: [breakout] }, pr, opts);
for (const st of [false, true]) {
  console.log(`\n=== BFK garanti : 5 Coverts Operation Breakout${st ? " StatTrak (donne un BFK StatTrak)" : ""} ===`);
  // tous les items achetables : floats connus, sinon pire float de l'usure (pile pas encore ouverte)
  const items = [];
  for (const name of breakout.inputs) {
    for (const w of cat.coverts[name].wears) {
      const h = E.hashName(name, w, st);
      for (const o of by[h] || []) {
        if (o.f.length) o.f.forEach((f) => items.push({ name, wear: w, float: f, price: o.trade, src: "ti" }));
        else for (let i = 0; i < Math.min(5, o.n); i++) items.push({ name, wear: w, price: o.trade, src: "ti" });
      }
    }
  }
  if (items.length < 5) { console.log("  pas assez d'items en stock"); continue; }
  const cheap = items.slice().sort((a, b) => a.price - b.price || (a.float == null) - (b.float == null) || (a.float || 1) - (b.float || 1)).slice(0, 5);
  const c0 = tiB.evaluate(cheap, { st });
  show(c0, "Le moins cher (BFK garanti au plus bas prix)");
  // compromis cout / usure du BFK : le plus rentable sous plusieurs plafonds
  for (const f of [1.1, 1.25]) {
    const b = tiB.stockContracts({ listings, st, fillers: 0, budget: c0.cost * f });
    show(b[0], `Le plus rentable pour au plus ${fmt(c0.cost * f)} (moins cher + ${Math.round((f - 1) * 100)} %)`);
  }
  const best = tiB.stockContracts({ listings, st, fillers: 0 });
  show(best[0], "Le plus rentable sans limite de cout (floats exacts, optimiseur exact)");
}

// ---------------------------------------------------- acheter un BFK directement
console.log("\n=== Acheter un Butterfly directement chez tradeit (prix d'echange) ===");
const direct = Object.entries(golds).filter(([h]) => isBfk(h) && !h.includes("StatTrak")).sort((a, b) => a[1].p - b[1].p).slice(0, 8);
for (const [h, g] of direct) console.log(`  ${h.padEnd(50)} ${fmt(g.p)}  (tradeit t'en redonnerait ${g.u ? fmt(g.u) : "?"})`);

// ---------------------------------------------------- caisses a 20 % de BFK
console.log("\n=== Autres caisses (20 % de BFK par input), 100 % de la caisse : meilleur contrat en monnaie d'echange ===");
for (const st of [false, true]) {
  const all = ti.stockContracts({ listings, st, fillers: 0 });
  for (const r of all.filter((x) => bfkCases.some((c) => c.case === x.case) && x.case !== breakout.case)) {
    const bfk = r.outcomes.filter((o) => isBfk(o.name)).reduce((s, o) => s + o.p, 0);
    const other = r.outcomes.filter((o) => !isBfk(o.name)).reduce((s, o) => s + o.p * (o.net || 0), 0);
    console.log(`  ${st ? "ST " : ""}${r.case}${r.fillers ? ` + ${r.fillers} d'une autre caisse` : ""} : cout ${fmt(r.cost)}, valeur moyenne ${fmt(r.ev)}, ` +
                `profit ${fmt(r.profit)} (${pc(r.roi)}), P(BFK) ${pc(bfk)}, cout moyen par BFK en echangeant le reste ${fmt((r.cost - other) / bfk)}`);
  }
}
