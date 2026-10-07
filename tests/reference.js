"use strict";
const WEARS = [["Factory New", 0, 0.07], ["Minimal Wear", 0.07, 0.15], ["Field-Tested", 0.15, 0.38],
               ["Well-Worn", 0.38, 0.45], ["Battle-Scarred", 0.45, 1]];
// Reference independante : on enumere TOUS les multisets de 5 inputs sans
// elagage ni precalcul, et on calcule le cout attendu directement.
function reference(cat, pr, target, opts) {
  const fee = opts.fee / 100, lim = opts.lim, st = !!opts.st;
  const nm = (n) => (!st ? n : n.startsWith("★ ") ? n.replace("★ ", "★ StatTrak™ ") : "StatTrak™ " + n);
  const q = (h) => {
    const it = pr.items[nm(h.replace(/ \([^)]*\)$/, "")) + (/ \([^)]*\)$/.test(h) ? h.match(/ \([^)]*\)$/)[0] : "")];
    if (!it) return null;
    const live = ["sk", "cf", "dm", "st"].map((k) => it[k] && it[k][0]).filter((v) => v > 0);
    return live.length ? Math.min(...live) : (it.fb ? it.fb[0] : null);
  };
  const gq = (o, w) => q(w ? `${o} (${w})` : o);
  const wearOf = (f) => { for (const [n, , hi] of WEARS) if (f < hi) return n; return "Battle-Scarred"; };
  const poolOf = (c) => c.pool.filter(([n]) => !st || cat.golds[n].st);
  const cands = [];
  cat.collections.forEach((c, ci) => {
    if (!poolOf(c).some(([n]) => n === target)) return;
    for (const name of c.inputs) {
      const sk = cat.coverts[name];
      for (const [w, lo, hi] of WEARS) {
        if (!(sk.min < hi && sk.max > lo)) continue;
        const p = q(`${name} (${w})`);
        if (p == null) continue;
        const b = Math.min(sk.max, hi);
        cands.push({ ci, price: p, x: (b - sk.min) / (sk.max - sk.min) });
      }
    }
  });
  if (opts.dedupe) {
    // meme caisse et meme float pire-cas : seul le moins cher peut servir
    // (effet identique sur la chance et la valeur, cout plus bas)
    const keep = new Map();
    for (const k of cands) {
      const key = k.ci + ":" + k.x.toFixed(12);
      if (!keep.has(key) || keep.get(key).price > k.price) keep.set(key, k);
    }
    cands.length = 0;
    cands.push(...keep.values());
  }
  let best = Infinity;
  const n = cands.length;
  // memo de la valeur d'un pool a x donne : meme calcul, juste pas refait
  const memo = new Map();
  const poolValue = (ci, x) => {
    const key = ci + ":" + x.toFixed(12);
    if (!memo.has(key)) memo.set(key, poolValueRaw(ci, x));
    return memo.get(key);
  };
  for (let a = 0; a < n; a++) for (let b = a; b < n; b++) for (let c = b; c < n; c++)
    for (let d = c; d < n; d++) for (let e = d; e < n; e++) {
      const pick = [a, b, c, d, e].map((i) => cands[i]);
      // juste sous le pire cas : les bornes hautes d'usure ne sont jamais atteintes
      const x = pick.reduce((s, k) => s + k.x, 0) / 5 - 1e-9;
      const tg = cat.golds[target];
      if (lim != null && !(tg.min + x * (tg.max - tg.min) < lim)) continue;
      const cost = pick.reduce((s, k) => s + k.price, 0);
      let p = 0, vo = 0;
      for (const k of pick) {
        const r = poolValue(k.ci, x);
        p += r.p / 5;
        vo += r.v / 5;
      }
      best = Math.min(best, (cost - vo) / p);
    }
  return best;

  function poolValueRaw(ci, x) {
      let p = 0, vo = 0;
      {
        const pool = poolOf(cat.collections[ci]);
        for (const [o] of pool) {
          const w = 1 / pool.length;
          if (o === target) { p += w; continue; }
          const g = cat.golds[o];
          let pr2 = null;
          if (!g.wears.length) pr2 = gq(o, null);
          else {
            // revente = prix le plus bas parmi l'usure obtenue et les meilleures ;
            // si aucune n'est cotee, prix de la meilleure usure cotee
            const got = wearOf(Math.min(g.min + x * (g.max - g.min), g.max - 1e-9));
            const order = WEARS.map((t) => t[0]);
            let first = null;
            for (const wv of g.wears) {
              const v = gq(o, wv);
              if (v == null) continue;
              if (first == null) first = v;
              if (order.indexOf(wv) > order.indexOf(got)) break;
              if (pr2 == null || v < pr2) pr2 = v;
            }
            if (pr2 == null) pr2 = first;
          }
          if (pr2) vo += w * pr2 * (1 - fee);
        }
      }
      return { p, v: vo };
  }
}

module.exports = { reference };
