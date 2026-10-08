/*
 * Moteur du simulateur : aucune dependance au DOM, testable sous Node.
 *
 * Regles modelisees (contrat Covert -> gold, patch du 23 octobre 2025) :
 *  - 5 Coverts en entree, tous StatTrak ou tous normaux ;
 *  - chaque input pese 1/5 : la caisse d'un input est tiree avec cette
 *    probabilite, puis un gold est tire uniformement dans le pool de la caisse ;
 *  - float de sortie = min + moyenne(position des inputs) x (max - min), la
 *    position d'un input etant (float - min) / (max - min) de son propre skin
 *    (formule "normalisee"). La formule "brute" moyenne les floats directement.
 */
(function (root) {
  "use strict";

  const LIVE = ["sk", "cf", "dm", "st"];   // sources de prix en direct
  const KEY_USD = 2.49;                     // prix d'une cle de caisse
  const P_GOLD = 0.0026;                    // chance officielle d'un objet rare a l'ouverture
  const SLOTS = 5;
  // Le float d'un input est strictement sous la borne haute de son usure (un MW
  // est < 0.15, jamais = 0.15) : le pire cas est une borne jamais atteinte. On
  // evalue donc juste en dessous, ce qui rend aussi le calcul insensible aux
  // arrondis de virgule flottante pile sur une frontiere d'usure.
  const EPS = 1e-9;

  function hashName(name, wear, st) {
    let n = name;
    if (st) n = name.startsWith("★ ") ? name.replace("★ ", "★ StatTrak™ ") : "StatTrak™ " + name;
    return wear ? `${n} (${wear})` : n;
  }

  function create(catalog, prices, opts) {
    opts = opts || {};
    const wears = catalog.wears;                         // [nom, bas, haut]
    const wearIdx = Object.fromEntries(wears.map((w, i) => [w[0], i]));
    const enabled = new Set(opts.sources || LIVE.concat("fb"));
    const fee = (opts.fee == null ? 2 : opts.fee) / 100;
    const phaseMode = opts.phaseMode || "merged";        // "merged" | "entries"
    const floatMode = opts.floatMode || "normalized";    // "normalized" | "raw"
    const keyPrice = opts.keyPrice == null ? KEY_USD : opts.keyPrice;  // devise des prix
    // Prix d'achat des inputs (Coverts). Par defaut le marche ; une fonction
    // hash -> { price, src } permet de les payer autrement (echange tradeit).
    // La valeur des resultats reste toujours celle du marche.
    const inputQuote = typeof opts.inputQuote === "function" ? opts.inputQuote : null;

    function wearOf(f) {
      for (const [n, , hi] of wears) if (f < hi) return n;
      return wears[wears.length - 1][0];
    }

    const qcache = new Map();
    /** Meilleur prix d'achat d'un market_hash_name sur les sources actives. */
    function quote(hash) {
      if (!qcache.has(hash)) qcache.set(hash, quoteRaw(hash));
      return qcache.get(hash);
    }

    function quoteRaw(hash) {
      const it = prices.items[hash];
      if (!it) return null;
      let best = null;
      for (const k of LIVE) {
        if (!enabled.has(k) || !it[k]) continue;
        const [p, q] = it[k];
        if (p > 0 && (!best || p < best.price)) {
          best = { price: p, src: k, qty: q, stale: !!(prices.sources[k] || {}).stale };
        }
      }
      if (!best && enabled.has("fb") && it.fb && it.fb[0] > 0) {
        best = { price: it.fb[0], src: "fb", qty: null, stale: true };
      }
      return best;
    }

    /** Tous les prix connus d'un item, source par source. */
    function quotesAll(hash) {
      const it = prices.items[hash] || {};
      return LIVE.concat("fb")
        .filter((k) => it[k])
        .map((k) => ({ src: k, price: it[k][0], qty: it[k][1], enabled: enabled.has(k) }));
    }

    /** Bornes de la contribution d'un input achete dans une usure donnee. */
    function xBounds(sk, wear) {
      const [, lo, hi] = wears[wearIdx[wear]];
      const a = Math.max(sk.min, lo), b = Math.min(sk.max, hi);
      if (floatMode === "raw") return [a, b];
      const span = sk.max - sk.min;
      return [(a - sk.min) / span, (b - sk.min) / span];
    }

    function outFloat(g, x) {
      return g.min + Math.min(Math.max(x, 0), 1) * (g.max - g.min);
    }

    /**
     * Valeur de revente d'un gold dans une usure.
     *  - Plafond : le prix le plus bas parmi cette usure et les usures
     *    meilleures. Personne n'achete un WW plus cher qu'un FT disponible
     *    moins cher ; sans ce plafond, une annonce isolee hors de prix dans
     *    une mauvaise usure gonflerait la valeur attendue.
     *  - Usure sans annonce, meilleure que toutes les usures cotees : elle vaut
     *    au moins la meilleure usure cotee, on prend ce prix (estimation basse).
     * Resultat : la valeur ne monte jamais quand le float monte, ce qui rend
     * l'elagage de l'optimiseur exact (voir prepare).
     */
    const vcache = new Map();
    function resale(name, wear, st) {
      const key = name + "\u0000" + wear + "\u0000" + st;
      if (vcache.has(key)) return vcache.get(key);
      const g = catalog.golds[name];
      let best = null, firstPriced = null;
      for (const w of g.wears) {
        const q = quote(hashName(name, w, st));
        if (!q) continue;
        if (!firstPriced) firstPriced = { price: q.price, wear: w };
        if (wearIdx[w] > wearIdx[wear]) break;
        if (!best || q.price < best.price) best = { price: q.price, wear: w };
      }
      const v = best || firstPriced;     // null seulement si aucune usure n'est cotee
      vcache.set(key, v);
      return v;
    }

    /** Gold obtenu pour une contribution moyenne x : usure, prix et valeur. */
    function goldAt(name, x, st) {
      const g = catalog.golds[name];
      if (!g.wears.length) {
        const q = quote(hashName(name, null, st));
        return { wear: null, float: null, q, value: q ? q.price : null, cappedBy: null };
      }
      const f = outFloat(g, x);
      // un float egal au max du skin reste dans l'usure qui contient ce max
      const w = wearOf(Math.min(f, g.max - 1e-9));
      const v = resale(name, w, st);
      return { wear: w, float: f, q: quote(hashName(name, w, st)),
               value: v ? v.price : null, cappedBy: v && v.wear !== w ? v.wear : null };
    }

    /**
     * Valeur nette attendue des golds du pool autres que la cible, en
     * fonction de la contribution moyenne x. Elle ne change que quand un gold
     * change d'usure : on la calcule une fois par intervalle.
     */
    function othersCurve(pool, target, st) {
      const cuts = new Set([0]);
      for (const o of pool) {
        const g = catalog.golds[o.name];
        if (o.name === target || !g.wears.length) continue;
        for (const [, lo, hi] of wears) {
          for (const b of [lo, hi]) {
            const x = (b - g.min) / (g.max - g.min);
            if (x > 0 && x < 1) cuts.add(x);
          }
        }
      }
      const xs = [...cuts].sort((a, b) => a - b);
      const vals = xs.map((x0, i) => {
        const mid = (x0 + (i + 1 < xs.length ? xs[i + 1] : 1)) / 2;
        let v = 0;
        for (const o of pool) {
          if (o.name === target) continue;
          const r = goldAt(o.name, mid, st);
          if (r.value != null) v += o.w * r.value * (1 - fee);
        }
        return v;
      });
      return { xs, vals, max: Math.max(...vals) };
    }

    function curveAt(c, x) {
      const xs = c.xs;
      let lo = 0, hi = xs.length - 1;
      while (lo < hi) {                       // dernier point <= x
        const m = (lo + hi + 1) >> 1;
        if (xs[m] <= x) lo = m; else hi = m - 1;
      }
      return c.vals[lo];
    }

    function poolOf(col, st) {
      const entries = col.pool.filter(([n]) => !st || catalog.golds[n].st);
      const total = phaseMode === "entries"
        ? entries.reduce((s, [, k]) => s + k, 0)
        : entries.length;
      return entries.map(([n, k]) => ({ name: n, w: (phaseMode === "entries" ? k : 1) / total }));
    }

    /** Usures acceptables pour la cible : "minWear ou mieux". */
    function allowedWears(g, minWear) {
      if (!g.wears.length) return [null];
      if (!minWear || minWear === "any") return g.wears.slice();
      const lim = wearIdx[minWear];
      return g.wears.filter((w) => wearIdx[w] <= lim);
    }

    // ------------------------------------------------------- achat direct
    function direct(target, st, minWear) {
      const g = catalog.golds[target];
      const rows = allowedWears(g, minWear).map((w) => {
        const hash = hashName(target, w, st);
        return { wear: w, hash, q: quote(hash), all: quotesAll(hash) };
      });
      const priced = rows.filter((r) => r.q);
      const best = priced.length ? priced.reduce((a, b) => (b.q.price < a.q.price ? b : a)) : null;
      return { kind: "buy", rows, best, cost: best ? best.q.price : null };
    }

    // ------------------------------------------------------------ trade-up
    /**
     * Inputs achetables d'une caisse (un par Covert et par usure cotee), au
     * pire float de leur palier. Un input plus cher ET au pire float qu'un
     * autre de la meme caisse ne sert jamais : la valeur de revente (plafonnee,
     * cf. resale) ne monte pas quand le float monte, et les chances ne
     * dependent que de la caisse. Cet elagage est donc exact.
     */
    function candidatesFor(col, st) {
      const cands = [];
      for (const name of col.inputs) {
        const sk = catalog.coverts[name];
        if (st && !sk.st) continue;
        for (const w of sk.wears) {
          const hash = hashName(name, w, st);
          const q = inputQuote ? inputQuote(hash) : quote(hash);
          if (!q) continue;
          const [xlo, xhi] = xBounds(sk, w);
          cands.push({ name, wear: w, hash, q, price: q.price, xlo, xhi, float: Math.min(sk.max, wears[wearIdx[w]][2]) });
        }
      }
      return cands.filter((a) => !cands.some((b) =>
        b !== a && b.price <= a.price && b.xhi <= a.xhi && (b.price < a.price || b.xhi < a.xhi)));
    }

    function prepare(target, st) {
      const cols = [];
      for (const col of catalog.collections) {
        const pool = poolOf(col, st);
        const t = pool.find((o) => o.name === target);
        if (!t) continue;
        const front = candidatesFor(col, st);
        if (!front.length) continue;
        cols.push({ col, pool, wT: t.w, cands: front, others: othersCurve(pool, target, st) });
      }
      return cols;
    }

    /**
     * Cherche les 5 inputs qui minimisent le cout attendu pour obtenir la
     * cible : (cout du contrat - valeur des autres golds) / P(cible).
     */
    function optimize(target, st, minWear, cols) {
      const g = catalog.golds[target];
      const lim = (minWear && minWear !== "any" && g.wears.length) ? wears[wearIdx[minWear]][2] : null;
      const cands = [];
      cols.forEach((c, ci) => c.cands.forEach((k) => cands.push(Object.assign({ ci }, k))));
      if (!cands.length) return null;
      cands.sort((a, b) => a.price - b.price);

      // bornes pour elaguer : la revente des autres golds ne depasse jamais
      // vMax, et la chance de la cible reste entre pMin et pMax
      const vMax = Math.max(...cols.map((c) => c.others.max));
      const pMax = Math.max(...cols.map((c) => c.wT));
      const pMin = Math.min(...cols.map((c) => c.wT));

      const n = cands.length, counts = new Array(cols.length).fill(0), pick = [];
      let best = null;

      (function rec(start, depth, cost, xs) {
        if (depth === SLOTS) {
          const x = xs / SLOTS - EPS;
          if (lim != null && !(outFloat(g, x) < lim)) return;
          let p = 0, vo = 0;
          for (let c = 0; c < cols.length; c++) {
            if (!counts[c]) continue;
            const share = counts[c] / SLOTS;
            p += share * cols[c].wT;
            vo += share * curveAt(cols[c].others, x);
          }
          const e = (cost - vo) / p;
          if (!best || e < best.e) best = { e, cost, x, p, vo, pick: pick.slice() };
          return;
        }
        const left = SLOTS - depth;
        for (let i = start; i < n; i++) {
          const k = cands[i];
          if (best) {
            // les inputs suivants coutent au moins k.price : si meme dans le
            // meilleur des cas on ne bat pas l'optimum actuel, inutile d'aller plus loin
            const num = cost + left * k.price - vMax;
            if ((num >= 0 ? num / pMax : num / pMin) >= best.e) break;
          }
          counts[k.ci]++; pick.push(i);
          rec(i, depth + 1, cost + k.price, xs + k.xhi);
          counts[k.ci]--; pick.pop();
        }
      })(0, 0, 0, 0);

      if (!best) return { impossible: true, xNeeded: lim != null ? (lim - g.min) / (g.max - g.min) : null };
      return detail(target, st, cols, best.pick.map((i) => cands[i]), best);
    }

    function detail(target, st, cols, inputs, r) {
      const g = catalog.golds[target];
      // regroupe les inputs identiques
      const grouped = [];
      for (const k of inputs) {
        const e = grouped.find((x) => x.hash === k.hash);
        if (e) e.n++; else grouped.push(Object.assign({ n: 1, case: cols[k.ci].col.case }, k));
      }
      // probabilites de chaque gold, cumulees sur les caisses du contrat
      const shares = new Array(cols.length).fill(0);
      inputs.forEach((k) => (shares[k.ci] += 1 / SLOTS));
      const outcomes = new Map();
      cols.forEach((c, ci) => {
        if (!shares[ci]) return;
        for (const o of c.pool) {
          const cur = outcomes.get(o.name) || { name: o.name, p: 0, cases: [] };
          cur.p += shares[ci] * o.w;
          cur.cases.push(c.col.case);
          outcomes.set(o.name, cur);
        }
      });
      const list = [...outcomes.values()].map((o) => {
        const at = goldAt(o.name, r.x, st);
        return Object.assign(o, at, {
          hash: hashName(o.name, at.wear, st),
          net: at.value != null ? at.value * (1 - fee) : null,
          isTarget: o.name === target,
        });
      }).sort((a, b) => (b.isTarget - a.isTarget) || (b.p - a.p) || ((b.net || 0) - (a.net || 0)));

      const tgt = list.find((o) => o.isTarget);
      const ev = list.reduce((s, o) => s + o.p * (o.net || 0), 0);
      const n90 = r.p >= 1 ? 1 : Math.ceil(Math.log(0.1) / Math.log(1 - r.p));
      return {
        kind: "tradeup",
        cases: [...new Set(grouped.map((k) => k.case))],
        inputs: grouped,
        cost: r.cost,                   // prix d'un contrat
        p: r.p,                         // chance d'obtenir la cible par contrat
        othersValue: r.vo,              // revente attendue des autres golds
        expected: r.e,                  // cout attendu pour obtenir la cible
        ev,                             // valeur attendue totale d'un contrat
        profit: ev - r.cost,
        tries: 1 / r.p,
        n90,
        x: r.x,
        targetWear: tgt.wear,
        targetFloat: tgt.float,
        targetQuote: tgt.q,
        outcomes: list,
        unpriced: list.filter((o) => o.value == null).length,
        // borne (jamais atteinte) du float de la cible : le float reel est en dessous
        targetFloatSup: g.wears.length ? outFloat(g, r.x + EPS) : null,
      };
    }

    // ------------------------------------------- contrat compose a la main
    const colOf = {};
    for (const col of catalog.collections) for (const n of col.inputs) colOf[n] = col;

    /**
     * Evalue un contrat donne. inputs : [{ name, wear?, float?, price? }]
     *  - float exact connu : position exacte ; sinon pire float du palier
     *    (borne jamais atteinte, evaluee juste en dessous) ;
     *  - price impose (inventaire, autre site), sinon meilleur prix des sources.
     * Les chiffres de rentabilite ne sont calcules que pour 5 inputs cotes.
     */
    function evaluate(inputs, o) {
      o = o || {};
      const st = !!o.st;
      const errors = [];
      const rows = inputs.map((it) => {
        const sk = catalog.coverts[it.name];
        const col = colOf[it.name];
        if (!sk || !col) { errors.push(`Covert inconnu : ${it.name}`); return null; }
        if (st && !sk.st) errors.push(`${it.name} n'existe pas en StatTrak™`);
        let wear = it.wear, float = it.float, x, exact = false;
        if (float != null && float !== "" && isFinite(float)) {
          float = Math.min(Math.max(+float, sk.min), sk.max);
          wear = wearOf(Math.min(float, sk.max - 1e-9));
          x = floatMode === "raw" ? float : (float - sk.min) / (sk.max - sk.min);
          exact = true;
        } else {
          if (!wear || !sk.wears.includes(wear)) wear = sk.wears[sk.wears.length - 1];
          x = xBounds(sk, wear)[1];
          float = Math.min(sk.max, wears[wearIdx[wear]][2]);
        }
        const hash = hashName(it.name, wear, st);
        const manual = it.price != null && it.price !== "" && isFinite(it.price);
        const q = manual ? { price: +it.price, src: "manual", stale: false }
          : (inputQuote ? inputQuote(hash) : quote(hash));
        return { name: it.name, case: col.case, col, wear, float, exact, x, hash, q,
                 price: q ? q.price : null, img: sk.img };
      }).filter(Boolean);

      const n = rows.length;
      const res = { st, inputs: rows, n, complete: n === SLOTS, errors, outcomes: [] };
      if (!n) return res;

      const anySup = rows.some((r) => !r.exact);
      const x = rows.reduce((s, r) => s + r.x, 0) / n - (anySup ? EPS : 0);
      res.x = x;

      // chaque input pese 1/n de la probabilite (1/5 pour un contrat complet)
      const byCase = new Map();
      for (const r of rows) byCase.set(r.col, (byCase.get(r.col) || 0) + 1);
      const acc = new Map();
      for (const [col, k] of byCase) {
        const pool = poolOf(col, st);
        if (!pool.length) {
          errors.push(`${col.case} ne contient que des gants : pas de contrat StatTrak™ possible`);
          continue;
        }
        for (const p of pool) {
          const cur = acc.get(p.name) || { name: p.name, p: 0, cases: [] };
          cur.p += (k / n) * p.w;
          if (!cur.cases.includes(col.case)) cur.cases.push(col.case);
          acc.set(p.name, cur);
        }
      }

      const cost = rows.every((r) => r.price != null) ? rows.reduce((s, r) => s + r.price, 0) : null;
      res.cost = cost;
      res.outcomes = [...acc.values()].map((oc) => {
        const at = goldAt(oc.name, x, st);
        const net = at.value != null ? at.value * (1 - fee) : null;
        return Object.assign(oc, at, {
          hash: hashName(oc.name, at.wear, st),
          img: catalog.golds[oc.name].img,
          net,
          profit: net != null && cost != null ? net - cost : null,
          roi: net != null && cost ? net / cost - 1 : null,
        });
      }).sort((a, b) => (b.net == null) - (a.net == null) || (b.net || 0) - (a.net || 0));
      res.unpriced = res.outcomes.filter((oc) => oc.net == null).length;

      if (res.complete && cost != null && !errors.length) {
        const ev = res.outcomes.reduce((s, oc) => s + oc.p * (oc.net || 0), 0);
        const priced = res.outcomes.filter((oc) => oc.net != null);
        Object.assign(res, {
          ev,
          profit: ev - cost,
          roi: ev / cost - 1,
          pWin: res.outcomes.reduce((s, oc) => s + (oc.net != null && oc.net > cost ? oc.p : 0), 0),
          best: priced[0] || null,
          worst: priced[priced.length - 1] || null,
        });
      }
      return res;
    }

    /**
     * Contrat le plus rentable de chaque caisse (5 inputs de la meme caisse,
     * pire float de chaque palier achete) : profit moyen = revente attendue
     * de tous les golds possibles - cout. Exact grace au meme elagage.
     */
    function bestContracts(o) {
      o = o || {};
      const st = !!o.st;
      const budget = o.budget > 0 ? o.budget : Infinity;
      const out = [];
      for (const col of catalog.collections) {
        const pool = poolOf(col, st);
        if (!pool.length) continue;
        const cands = candidatesFor(col, st).sort((a, b) => a.price - b.price);
        if (!cands.length) continue;
        const curve = othersCurve(pool, null, st);        // tous les golds du pool
        const n = cands.length, pick = [];
        let best = null;
        (function rec(start, depth, cost, xs) {
          if (depth === SLOTS) {
            const profit = curveAt(curve, xs / SLOTS - EPS) - cost;
            if (!best || profit > best.profit) best = { profit, pick: pick.slice() };
            return;
          }
          const left = SLOTS - depth;
          for (let i = start; i < n; i++) {
            const k = cands[i];
            const floor = cost + left * k.price;          // les suivants coutent au moins autant
            if (floor > budget) break;
            if (best && curve.max - floor <= best.profit) break;
            pick.push(i);
            rec(i, depth + 1, cost + k.price, xs + k.xhi);
            pick.pop();
          }
        })(0, 0, 0, 0);
        if (!best) continue;
        const r = evaluate(best.pick.map((i) => ({ name: cands[i].name, wear: cands[i].wear })), { st });
        if (r.ev == null) continue;
        out.push(Object.assign(r, { case: col.case, caseImg: col.img }));
      }
      const key = o.sort || "profit";
      out.sort((a, b) => (b[key] || 0) - (a[key] || 0));
      return out;
    }

    // ------------------------------------------------- ouverture de caisses
    function unbox(target, st, minWear, col) {
      const g = catalog.golds[target];
      const pool = poolOf(col, false);
      const t = pool.find((o) => o.name === target);
      const cq = quote(col.hash);
      if (!t || !cq) return null;
      let frac = 1;
      if (minWear && minWear !== "any" && g.wears.length) {
        const hi = wears[wearIdx[minWear]][2];
        frac = Math.min(1, Math.max(0, (hi - g.min) / (g.max - g.min)));
      }
      const p = P_GOLD * t.w * frac * (st ? 0.1 : 1);
      if (!p) return null;
      const cost = cq.price + keyPrice;
      return { kind: "unbox", case: col.case, caseQuote: cq, cost, p, expected: cost / p, tries: 1 / p };
    }

    // ---------------------------------------------------------- analyse
    function analyze(target, o) {
      o = o || {};
      const g = catalog.golds[target];
      if (!g) throw new Error("gold inconnu : " + target);
      const st = !!o.st && g.st;
      const minWear = o.minWear || "any";

      const methods = [];
      const buy = direct(target, st, minWear);
      if (buy.best) methods.push(Object.assign({ label: "Acheter directement", expected: buy.cost }, buy));

      const cols = prepare(target, st);
      const notes = [];
      if (cols.length) {
        const all = optimize(target, st, minWear, cols);
        if (all && all.impossible) {
          notes.push({ kind: "float", xNeeded: all.xNeeded });
        } else if (all) {
          // l'etiquette decrit ce que contient vraiment le contrat retenu
          all.label = all.cases.length > 1
            ? `Trade-up mixte ${all.cases.join(" + ")}`
            : `Trade-up 100 % ${all.cases[0]}`;
          all.optimal = true;
          methods.push(all);
          if (cols.length > 1) {
            for (const c of cols) {
              const one = optimize(target, st, minWear, [c]);
              if (!one || one.impossible) continue;
              // inutile d'afficher deux fois le meme contrat
              const same = all.cases.length === 1 && all.cases[0] === c.col.case;
              if (same) continue;
              one.label = `Trade-up 100 % ${c.col.case}`;
              methods.push(one);
            }
          }
        }
      }
      for (const col of catalog.collections) {
        const u = unbox(target, st, minWear, col);
        if (u) { u.label = `Ouvrir des ${col.case}`; methods.push(u); }
      }
      methods.sort((a, b) => a.expected - b.expected);
      return {
        target, gold: g, st, minWear, buy, methods, notes,
        cases: catalog.collections.filter((c) => poolOf(c, st).some((x) => x.name === target)).map((c) => c.case),
      };
    }

    return { analyze, evaluate, bestContracts, quote, quotesAll, hashName, wearOf,
             poolOf, allowedWears, goldAt, caseOf: (name) => colOf[name] };
  }

  const api = { create, hashName, LIVE, KEY_USD, P_GOLD };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TradeupEngine = api;
})(typeof self !== "undefined" ? self : this);
