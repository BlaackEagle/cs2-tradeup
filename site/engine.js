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
    // hash -> { price, src } permet de les payer autrement.
    const inputQuote = typeof opts.inputQuote === "function" ? opts.inputQuote : null;
    // Autre jeu de prix complet, hash -> { price, src } ou null :
    //   quote      : prix d'achat (inputs, achat direct d'un gold) a la place des marches ;
    //   valueQuote : valeur d'un gold obtenu (ex. ce que tradeit en donne en echange).
    // Sans valueQuote, un gold vaut son prix d'achat le plus bas.
    const customQuote = typeof opts.quote === "function" ? opts.quote : null;
    const customValue = typeof opts.valueQuote === "function" ? opts.valueQuote : null;

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

    const valcache = new Map();
    /** Valeur d'un gold obtenu par contrat (avant frais de revente). */
    function valueOf(hash) {
      if (!customValue) return quote(hash);
      if (!valcache.has(hash)) valcache.set(hash, customValue(hash));
      return valcache.get(hash);
    }

    function quoteRaw(hash) {
      if (customQuote) return customQuote(hash);
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
        const q = valueOf(hashName(name, w, st));
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
        const q = valueOf(hashName(name, null, st));
        return { wear: null, float: null, q, value: q ? q.price : null, cappedBy: null, est: !!(q && q.est) };
      }
      const f = outFloat(g, x);
      // un float egal au max du skin reste dans l'usure qui contient ce max
      const w = wearOf(Math.min(f, g.max - 1e-9));
      const v = resale(name, w, st);
      const q = v ? valueOf(hashName(name, v.wear, st)) : null;
      return { wear: w, float: f, q: valueOf(hashName(name, w, st)),
               value: v ? v.price : null, cappedBy: v && v.wear !== w ? v.wear : null, est: !!(q && q.est) };
    }

    /**
     * Valeur nette attendue des golds du pool autres que la cible, en
     * fonction de la contribution moyenne x. Elle ne change que quand un gold
     * change d'usure : on la calcule une fois par intervalle.
     */
    function othersCurve(pool, target, st) {
      const isT = target instanceof Set ? (n) => target.has(n) : (n) => n === target;
      const cuts = new Set([0]);
      for (const o of pool) {
        const g = catalog.golds[o.name];
        if (isT(o.name) || !g.wears.length) continue;
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
          if (isT(o.name)) continue;
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
    function direct(tset, st, minWear) {
      const rows = [];
      for (const name of tset) {
        for (const w of allowedWears(catalog.golds[name], minWear)) {
          const hash = hashName(name, w, st);
          rows.push({ name, wear: w, hash, q: quote(hash), all: quotesAll(hash) });
        }
      }
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

    function prepare(tset, st) {
      const cols = [];
      for (const col of catalog.collections) {
        const pool = poolOf(col, st);
        const wT = pool.reduce((s, o) => s + (tset.has(o.name) ? o.w : 0), 0);
        if (!wT) continue;
        const front = candidatesFor(col, st);
        if (!front.length) continue;
        cols.push({ col, pool, wT, cands: front, others: othersCurve(pool, tset, st) });
      }
      return cols;
    }

    /**
     * Cherche les 5 inputs qui minimisent le cout attendu pour obtenir la
     * cible : (cout du contrat - valeur des autres golds) / P(cible).
     */
    function optimize(tset, st, minWear, cols) {
      // usure minimale : seulement pour une cible unique (chaque gold a sa plage de float)
      const g = tset.size === 1 ? catalog.golds[[...tset][0]] : null;
      const lim = (g && minWear && minWear !== "any" && g.wears.length) ? wears[wearIdx[minWear]][2] : null;
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
      return detail(tset, st, cols, best.pick.map((i) => cands[i]), best);
    }

    function detail(tset, st, cols, inputs, r) {
      const g = tset.size === 1 ? catalog.golds[[...tset][0]] : null;
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
          isTarget: tset.has(o.name),
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
        targetFloatSup: g && g.wears.length ? outFloat(g, r.x + EPS) : null,
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
        // prix impose : saisi a la main, ou item precis en stock (src "ti" + prix d'echange)
        const q = manual ? { price: +it.price, src: it.src || "manual", trade: it.trade, stale: false }
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

    /**
     * Meilleurs contrats avec des items PRECIS en stock : float exact, prix
     * propre a chaque item, un seul exemplaire de chacun.
     *   listings : { market_hash_name: [[float, prix], ...] }
     *   rate     : multiplie chaque prix (prix d'echange tradeit -> valeur
     *              marche des items que tu cedes) ; le prix d'origine reste
     *              dans q.trade de chaque input
     *   fillers  : inputs d'autres caisses permis a cote de la caisse
     *              principale (0 = contrat 100 % d'une caisse, 2 au plus)
     *   budget   : cout maximal d'un contrat (dans l'unite de price)
     * Rend le meilleur contrat de chaque caisse principale, trie, avec
     * .overall = le meilleur toutes caisses confondues.
     *
     * Methode exacte. La valeur attendue ne depend que de la caisse de chaque
     * input et de la position moyenne x des inputs. Entre deux frontieres
     * d'usure des golds, un item apporte une part fixe
     *   w = valeur moyenne des golds de sa caisse / 5 - son prix,
     * et il reste a choisir les 5 items de plus grande somme w dont la
     * moyenne des positions reste sous la frontiere (branch & bound). La
     * valeur ne montant jamais avec x, un contrat plus bas que l'intervalle
     * vaut au moins autant : le maximum sur les intervalles est le bon.
     */
    function stockContracts(o) {
      o = o || {};
      const st = !!o.st;
      const rate = o.rate > 0 ? o.rate : 1;
      const budget = o.budget > 0 ? o.budget : Infinity;
      const need = SLOTS - Math.min(2, Math.max(0, Math.round(o.fillers || 0)));
      const listings = o.listings || {};
      // position moyenne maximale (strictement en dessous) : usure minimale d'une cible
      const maxX = o.maxX > 0 ? o.maxX : Infinity;

      const cols = [];
      for (const col of catalog.collections) {
        const pool = poolOf(col, st);
        if (!pool.length) continue;
        let items = [];
        for (const name of col.inputs) {
          const sk = catalog.coverts[name];
          if (st && !sk.st) continue;
          for (const w of sk.wears) {
            const hash = hashName(name, w, st);
            for (const [f, p] of listings[hash] || []) {
              if (!(f >= sk.min && f <= sk.max) || !(p > 0)) continue;
              const x = floatMode === "raw" ? f : (f - sk.min) / (sk.max - sk.min);
              items.push({ name, wear: w, hash, float: f, x, trade: p, price: p * rate });
            }
          }
        }
        // Un item que 5 autres items de la meme caisse battent a la fois sur
        // le prix et sur la position ne sert jamais : un contrat en prend au
        // plus 4 autres, on l'echange contre un libre (meme caisse, moins cher,
        // position plus basse donc valeur au moins egale).
        items = items.filter((a) => {
          let beaten = 0;
          for (const b of items) {
            if (b !== a && b.price <= a.price && b.x <= a.x && (b.price < a.price || b.x < a.x) && ++beaten >= SLOTS) return false;
          }
          return true;
        });
        if (items.length) cols.push({ col, items, curve: othersCurve(pool, null, st) });
      }
      const all = [];
      cols.forEach((c, ci) => c.items.forEach((it) => { it.ci = ci; all.push(it); }));

      // Items interchangeables (meme skin, meme usure, meme prix) : on les
      // prend toujours du plus bas float au plus haut, ce qui evite
      // d'explorer plusieurs fois le meme contrat.
      all.sort((a, b) => a.x - b.x);
      const groups = new Map();
      for (const it of all) {
        const k = it.hash + "\u0000" + it.price;
        if (!groups.has(k)) groups.set(k, { id: groups.size, n: 0 });
        const g = groups.get(k);
        it.g = g.id; it.rank = g.n++;
      }
      const taken = new Int32Array(groups.size);

      // intervalles de x ou aucun gold ne change d'usure, et valeur de chaque caisse
      const T = [...new Set(cols.flatMap((c) => c.curve.xs))].sort((a, b) => a - b);
      const V = cols.map((c) => T.map((t) => curveAt(c.curve, t)));
      const locate = (x) => {
        let lo = 0, hi = T.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= x) lo = m; else hi = m - 1; }
        return lo;
      };

      /** liste triee par w decroissant, avec sommes et minima de suffixe pour les bornes */
      function seq(L) {
        const n = L.length;
        const pre = new Float64Array(n + 1), minX = new Float64Array(n + 1), minP = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + L[i].w;
        minX[n] = minP[n] = Infinity;
        for (let i = n - 1; i >= 0; i--) {
          minX[i] = Math.min(L[i].it.x, minX[i + 1]);
          minP[i] = Math.min(L[i].it.price, minP[i + 1]);
        }
        return { L, n, pre, minX, minP };
      }
      const top = (s, c) => (c <= s.n ? s.pre[c] : -Infinity);

      // par intervalle : tous les items tries par part w, et ceux de chaque caisse
      const lists = T.map((t, j) => {
        const L = all.map((it) => ({ it, w: V[it.ci][j] / SLOTS - it.price }))
          .sort((a, b) => b.w - a.w || a.it.x - b.it.x);
        const byCol = cols.map(() => []);
        for (const e of L) byCol[e.it.ci].push(e);
        return { hi: Math.min(j + 1 < T.length ? T[j + 1] : Infinity, maxX), L, byCol: byCol.map(seq), any: null };
      }).filter((d, j) => T[j] < maxX);

      /**
       * Items utiles sur un intervalle quand la caisse importe peu : un item
       * que 5 autres battent a la fois sur w, la position et le prix est
       * remplacable (les 5 premiers qui le battent sont eux-memes gardes).
       */
      function anyOf(d) {
        if (d.any) return d.any;
        const keep = [];
        if (budget === Infinity) {
          // les items precedents ont tous un w au moins egal : il suffit que
          // 5 d'entre eux aient une position au plus egale
          const low = [];                                  // 5 plus petites positions vues
          for (const e of d.L) {
            const x = e.it.x;
            if (low.length < SLOTS || low[SLOTS - 1] > x) keep.push(e);
            if (low.length < SLOTS) low.push(x);
            else if (x < low[SLOTS - 1]) low[SLOTS - 1] = x;
            else continue;
            for (let i = low.length - 1; i > 0 && low[i] < low[i - 1]; i--) {
              const t = low[i]; low[i] = low[i - 1]; low[i - 1] = t;
            }
          }
        } else {
          const L = d.L;
          for (let i = 0; i < L.length; i++) {
            const a = L[i].it;
            let beaten = 0;
            for (let k = 0; k < i && beaten < SLOTS; k++) {
              const b = L[k].it;
              if (b.x <= a.x && b.price <= a.price) beaten++;
            }
            if (beaten < SLOTS) keep.push(L[i]);
          }
        }
        return (d.any = seq(keep));
      }

      /**
       * Recherche en etages : `count` items pris dans chaque liste, dans
       * l'ordre (les complements d'abord, sans la caisse `skip`), en gardant
       * la moyenne des positions sous `hi`. Met a jour ctx si mieux.
       */
      function run(stages, hi, ctx, skip) {
        const ns = stages.length, hiSum = hi * SLOTS;
        const restW = new Float64Array(ns + 1), restX = new Float64Array(ns + 1), restP = new Float64Array(ns + 1);
        for (let s = ns - 1; s >= 0; s--) {
          const [S, c] = stages[s];
          restW[s] = restW[s + 1] + top(S, c);
          restX[s] = restX[s + 1] + c * S.minX[0];
          restP[s] = restP[s + 1] + c * S.minP[0];
        }
        const pick = [];
        (function rec(s, start, left, wsum, xs, cost) {
          if (!left) {
            if (s + 1 < ns) { rec(s + 1, 0, stages[s + 1][1], wsum, xs, cost); return; }
            const x = xs / SLOTS;
            if (!(x < hi)) return;
            const jj = locate(x);                           // intervalle reel : valeur exacte
            let ev = 0;
            for (const e of pick) ev += V[e.it.ci][jj];
            const profit = ev / SLOTS - cost;
            if (profit > ctx.best) { ctx.best = profit; ctx.pick = pick.map((e) => e.it); }
            return;
          }
          const { L, n, pre, minX, minP } = stages[s][0];
          const rw = restW[s + 1], rx = restX[s + 1], rp = restP[s + 1];
          for (let i = start; i <= n - left; i++) {
            if (wsum + pre[i + left] - pre[i] + rw <= ctx.best) break;   // w decroissants
            if (xs + left * minX[i] + rx >= hiSum) break;                // plus assez d'items assez bas
            if (cost + left * minP[i] + rp > budget) break;
            const e = L[i], it = e.it;
            if (s === 0 && it.ci === skip) continue;
            if (it.rank !== taken[it.g]) continue;
            const more = left > 1;
            if (xs + it.x + (more ? (left - 1) * minX[i + 1] : 0) + rx >= hiSum) continue;
            if (cost + it.price + (more ? (left - 1) * minP[i + 1] : 0) + rp > budget) continue;
            taken[it.g]++; pick.push(e);
            rec(s, i + 1, left - 1, wsum + e.w, xs + it.x, cost + it.price);
            taken[it.g]--; pick.pop();
          }
        })(0, 0, stages[0][1], 0, 0, 0);
      }

      /** meilleur contrat avec au moins k inputs de la caisse mc (mc = -1 : toutes caisses) */
      function search(mc, k) {
        const ctx = { best: -Infinity, pick: null }, plans = [];
        for (const d of lists) {
          if (mc < 0) {
            const S = anyOf(d);
            if (S.n >= SLOTS) plans.push({ d, ub: top(S, SLOTS), stages: [[S, SLOTS]], skip: -1 });
            continue;
          }
          const A = d.byCol[mc];
          for (let m = 0; m <= SLOTS - k; m++) {               // m complements d'autres caisses
            if (A.n < SLOTS - m) continue;
            if (!m) { plans.push({ d, ub: top(A, SLOTS), stages: [[A, SLOTS]], skip: -1 }); continue; }
            const O = anyOf(d);
            let ow = 0, got = 0;
            for (let i = 0; i < O.n && got < m; i++) if (O.L[i].it.ci !== mc) { ow += O.L[i].w; got++; }
            if (got < m) continue;
            plans.push({ d, ub: top(A, SLOTS - m) + ow, stages: [[O, m], [A, SLOTS - m]], skip: mc });
          }
        }
        // du plus prometteur au moins prometteur : on s'arrete des que la
        // borne (sans contrainte de float) ne peut plus battre le meilleur
        plans.sort((a, b) => b.ub - a.ub);
        for (const p of plans) {
          if (p.ub <= ctx.best) break;
          run(p.stages, p.d.hi, ctx, p.skip);
        }
        return ctx.pick;
      }

      const contract = (pick, extra) => {
        const r = evaluate(pick.map((it) => ({ name: it.name, float: it.float, price: it.price,
          trade: it.trade, src: o.src || "stock" })), { st });
        if (r.ev == null) return null;
        const cases = [...new Set(r.inputs.map((x) => x.case))];
        return Object.assign(r, { cases, mixed: cases.length > 1 }, extra);
      };
      const out = [];
      cols.forEach((c, ci) => {
        const pick = search(ci, need);
        const r = pick && contract(pick, { case: c.col.case, caseImg: c.col.img, stock: c.items.length });
        if (r) { r.fillers = r.inputs.filter((x) => x.case !== c.col.case).length; out.push(r); }
      });
      const gp = search(-1, 0);
      const overall = gp ? contract(gp, {}) : null;

      const key = o.sort || "profit";
      const dir = key === "cost" ? -1 : 1;
      out.sort((a, b) => dir * ((b[key] || 0) - (a[key] || 0)));
      out.overall = overall;
      out.items = all.length;
      return out;
    }

    // ------------------------------------------------- ouverture de caisses
    function unbox(tset, st, minWear, col) {
      const g = tset.size === 1 ? catalog.golds[[...tset][0]] : null;
      const pool = poolOf(col, false);
      const w = pool.reduce((s, o) => s + (tset.has(o.name) ? o.w : 0), 0);
      const cq = quote(col.hash);
      if (!w || !cq) return null;
      let frac = 1;
      if (g && minWear && minWear !== "any" && g.wears.length) {
        const hi = wears[wearIdx[minWear]][2];
        frac = Math.min(1, Math.max(0, (hi - g.min) / (g.max - g.min)));
      }
      const p = P_GOLD * w * frac * (st ? 0.1 : 1);
      if (!p) return null;
      const cost = cq.price + keyPrice;
      return { kind: "unbox", case: col.case, caseQuote: cq, cost, p, expected: cost / p, tries: 1 / p };
    }

    // ---------------------------------------------------------- analyse
    /**
     * Toutes les facons d'obtenir la cible : un gold (son nom), ou plusieurs
     * (tableau de noms, ex. toutes les finitions d'un couteau : on veut "un
     * Butterfly, n'importe lequel"). L'usure minimale ne vaut que pour une
     * cible unique.
     */
    function analyze(target, o) {
      o = o || {};
      const names = Array.isArray(target) ? target : [target];
      for (const n of names) if (!catalog.golds[n]) throw new Error("gold inconnu : " + n);
      const tset = new Set(names);
      const g = names.length === 1 ? catalog.golds[names[0]] : null;
      const st = !!o.st && names.some((n) => catalog.golds[n].st);
      const minWear = g ? o.minWear || "any" : "any";

      const methods = [];
      const buy = direct(tset, st, minWear);
      if (buy.best) methods.push(Object.assign({ label: "Acheter directement", expected: buy.cost }, buy));

      const cols = prepare(tset, st);
      const notes = [];
      if (cols.length) {
        const all = optimize(tset, st, minWear, cols);
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
              const one = optimize(tset, st, minWear, [c]);
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
        const u = unbox(tset, st, minWear, col);
        if (u) { u.label = `Ouvrir des ${col.case}`; methods.push(u); }
      }
      methods.sort((a, b) => a.expected - b.expected);
      return {
        target, names, gold: g, st, minWear, buy, methods, notes,
        cases: catalog.collections.filter((c) => poolOf(c, st).some((x) => tset.has(x.name))).map((c) => c.case),
      };
    }

    return { analyze, evaluate, bestContracts, stockContracts, quote, quotesAll, hashName, wearOf,
             poolOf, allowedWears, goldAt, caseOf: (name) => colOf[name] };
  }

  const api = { create, hashName, LIVE, KEY_USD, P_GOLD };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TradeupEngine = api;
})(typeof self !== "undefined" ? self : this);
