// Verification lente : golds presents dans beaucoup de caisses, contre l'exhaustif.
"use strict";
const path = require("path"), fs = require("fs");
const E = require(path.join(__dirname, "..", "site", "engine.js"));
const { reference } = require("./reference.js");
const dir = path.join(__dirname, "..", "site", "data");
const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json")));
const pr = JSON.parse(fs.readFileSync(path.join(dir, "prices.json")));
let bad = 0;
for (const [name, st, minWear, lim] of [
  ["★ Karambit | Fade", false, "any", null], ["★ Bayonet | Case Hardened", false, "any", null],
  ["★ M9 Bayonet", true, "any", null], ["★ Karambit | Fade", false, "Factory New", 0.07]]) {
  const t0 = Date.now();
  const tu = E.create(cat, pr, { fee: 2 }).analyze(name, { st, minWear }).methods.find((x) => x.optimal);
  const t1 = Date.now();
  const ref = reference(cat, pr, name, { fee: 2, lim, st, dedupe: true });
  const ok = tu ? Math.abs(tu.expected - ref) <= 1e-6 * Math.max(1, Math.abs(ref)) : !isFinite(ref);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "ECHEC"} ${name} st=${st} ${minWear} : moteur ${tu && tu.expected.toFixed(2)} (${t1 - t0} ms), exhaustif ${ref.toFixed(2)} (${Date.now() - t1} ms)`);
}
process.exitCode = bad ? 1 : 0;
