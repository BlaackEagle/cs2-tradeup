/* Interface du simulateur. Tous les calculs sont dans engine.js. */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const mem = {
    get(k, d) { try { const v = localStorage.getItem("tu:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("tu:" + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem("tu:" + k); } catch (e) { /* idem */ } },
  };

  const SHORT = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
  const EXAMPLES = ["★ Butterfly Knife (toutes finitions)", "★ Butterfly Knife | Doppler", "★ Karambit (toutes finitions)",
                    "★ Karambit | Doppler", "★ M9 Bayonet | Fade", "★ Sport Gloves | Vice", "★ Skeleton Knife | Fade"];
  const KEY_PRICE = 2.49;            // cle de caisse Steam
  const MARKET = ["sk", "cf", "dm", "st"];

  const DEFAULTS = {
    tab: "builder", st: false, cur: "EUR", fee: 2, phaseMode: "merged", floatMode: "normalized",
    off: ["fb"],                     // l'ancien releve Steam est exclu par defaut
    slots: [null, null, null, null, null],
    pay: "tradeit",                  // jeu de prix : "tradeit" (echange) | "market" (marches)
    v: 2,
    target: "★ Butterfly Knife | Doppler", minWear: "any",
    bestSort: "profit", bestBudget: "", ocSort: "value",
    tiOff: [],                       // items d'inventaire exclus de l'echange
    tiView: "contracts",             // onglet tradeit : "contracts" | "stock" | "inv"
    tiMix: 2,                        // Coverts d'autres caisses permis dans un contrat du stock
    tiSort: "profit", tiBudget: true, tiQ: "", tiStockSort: "price",
  };
  const state = Object.assign({}, DEFAULTS, mem.get("state", {}));
  if (state.tiStockSort === "deal") state.tiStockSort = "price";   // ancien tri (comparaison aux marches)
  if (!(state.v >= 2)) { state.pay = "tradeit"; state.v = 2; }        // les prix tradeit deviennent ceux par defaut
  if (!Array.isArray(state.slots) || state.slots.length !== 5) state.slots = DEFAULTS.slots.slice();
  const save = () => mem.set("state", state);

  let catalog, prices, inv = null, invFile = null;
  let stockRaw = null, stockCache = null;     // stock de la boutique tradeit (data/tradeit.json)
  const covertOf = {};                        // market_hash_name d'un Covert -> { name, wear, st }
  const engines = new Map();

  // ------------------------------------------------------------ formats
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const base = () => prices.currency || "USD";
  const usdEur = () => (prices.fx && (prices.fx.USD_EUR || prices.fx.EUR)) || 0.86;

  /** montant dans la devise des prix -> texte dans la devise choisie */
  function money(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    let x = v;
    if (state.cur !== base()) x = state.cur === "EUR" ? v * usdEur() : v / usdEur();
    const d = digits != null ? digits : (Math.abs(x) >= 1000 ? 0 : 2);
    return x.toLocaleString("fr-FR", { style: "currency", currency: state.cur, currencyDisplay: "narrowSymbol",
                                        minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const signed = (v, d) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), d));
  const usdToBase = (usd) => (base() === "EUR" ? usd * usdEur() : usd);
  function pct(p, sign) {
    if (p == null || !isFinite(p)) return "—";
    const v = p * 100, a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
    const s = a.toLocaleString("fr-FR", { maximumFractionDigits: d });
    return (sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : (v < 0 ? "−" : "")) + s + " %";
  }
  const num = (n) => Math.round(n).toLocaleString("fr-FR");
  function ago(iso) {
    if (!iso) return "jamais";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "à l'instant";
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 172800) return `il y a ${Math.round(s / 3600)} h`;
    return `il y a ${Math.round(s / 86400)} j`;
  }
  const short = (n) => n.replace("★ ", "");
  const img = (src, alt) => src ? `<img src="${esc(src)}" alt="${esc(alt || "")}" loading="lazy" onerror="this.style.visibility='hidden'">` : `<img alt="">`;

  function link(src, hash) {
    const e = encodeURIComponent(hash);
    return {
      st: `https://steamcommunity.com/market/listings/730/${e}`,
      fb: `https://steamcommunity.com/market/listings/730/${e}`,
      cf: `https://csfloat.com/search?market_hash_name=${e}`,
      sk: `https://skinport.com/market?search=${encodeURIComponent(hash.replace(/ \([^)]*\)$/, ""))}`,
      dm: `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${e}`,
      ti: `https://tradeit.gg/csgo/trade?search=${encodeURIComponent(hash.replace(/ \([^)]*\)$/, ""))}`,
    }[src];
  }
  const srcName = (k) => k === "manual" ? "ton prix" : k === "ti" ? "tradeit" :
    ((prices.sources[k] && prices.sources[k].label) || k);
  function srcBadge(q, hash) {
    if (!q) return '<span class="muted small">pas en vente</span>';
    if (q.src === "manual") return '<span class="src manual">ton prix</span>';
    const href = link(q.src, hash);
    const cls = q.src === "ti" ? "src ti" : "src";
    return `<a class="${cls}" href="${href}" target="_blank" rel="noopener"${nativeTip(q.src, q.price)}>${esc(srcName(q.src))}</a>`;
  }
  /** montant d'origine sur le site quand il cote dans une autre devise */
  function nativeTip(src, price) {
    const s = prices.sources[src];
    if (!s || !s.native || s.native === base() || price == null) return "";
    const orig = base() === "EUR" ? price / usdEur() : price * usdEur();
    const t = orig.toLocaleString("fr-FR", { style: "currency", currency: s.native, currencyDisplay: "narrowSymbol" });
    return ` title="${esc(t)} sur ${esc(s.label)} (converti au taux BCE)"`;
  }

  // ------------------------------------------------------------ moteur
  /** solde d'echange : ce que tradeit t'accorde pour les items coches */
  function balance() {
    if (!inv) return null;
    let user = 0, n = 0;
    for (const it of inv.items) {
      if (state.tiOff.includes(it.key)) continue;
      user += it.user * it.qty; n += it.qty;
    }
    return { user, n };
  }

  const median = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };

  /**
   * Donnees tradeit (data/tradeit.json), dans la devise des prix :
   *   by[hash]    piles de Coverts en stock (prix d'echange, floats)
   *   golds[hash] couteaux et gants : prix d'echange p, valeur d'echange u
   *               (ce que tradeit t'accorde si tu les lui echanges)
   */
  function stockOffers() {
    if (!stockRaw || !stockRaw.items) return null;
    if (!stockCache) {
      const by = {}, listings = {}, golds = {};
      let items = 0, piles = 0, known = 0;
      for (const [hash, offers] of Object.entries(stockRaw.items)) {
        if (!covertOf[hash] || !Array.isArray(offers)) continue;
        // une pile dont les floats ne sont pas encore lus reste visible (prix, stock),
        // mais seuls les items de float connu entrent dans les contrats
        by[hash] = offers.filter((o) => o.p > 0 && o.n > 0)
          .map((o) => ({ trade: usdToBase(o.p / 100), n: o.n, f: o.f || [], hi: o.hi, lock: o.lock || 0, at: o.at || null }))
          .sort((a, b) => a.trade - b.trade);
        if (!by[hash].length) { delete by[hash]; continue; }
        listings[hash] = by[hash].flatMap((o) => o.f.map((f) => [f, o.trade]));
        for (const o of by[hash]) { items += o.n; piles++; if (o.f.length) known++; }
      }
      for (const [hash, g] of Object.entries(stockRaw.golds || {})) {
        if (g && g.p > 0) golds[hash] = { p: usdToBase(g.p / 100), u: g.u > 0 ? usdToBase(g.u / 100) : null, n: g.n || 0 };
      }
      // valeur d'echange d'un gold sans valeur lue : part mediane de son prix d'echange
      const share = median(Object.values(golds).filter((g) => g.u).map((g) => g.u / g.p));
      stockCache = { by, listings, golds, share, items, piles, known, hashes: Object.keys(by).length,
                     nGolds: Object.keys(golds).length };
    }
    return stockCache;
  }

  /**
   * Gold absent du stock tradeit : estimation a partir de son prix sur les
   * marches, au rapport median (valeur d'echange / prix marche) des golds
   * dont on connait les deux. Signale comme estime partout.
   */
  let goldK = null;
  function goldMarketRatio() {
    const so = stockOffers();
    if (!so) return null;
    if (goldK && goldK.so === so && goldK.off === state.off.join(",")) return goldK.v;
    const m = engine("market"), r = [];
    for (const [hash, g] of Object.entries(so.golds)) {
      const q = m.quote(hash);
      const u = g.u || (so.share ? g.p * so.share : null);
      if (q && q.price >= 5 && u) r.push(u / q.price);
    }
    goldK = { so, off: state.off.join(","), v: r.length >= 20 ? median(r) : null };
    return goldK.v;
  }

  /** prix d'achat en echange : la pile la moins chere d'un Covert, le prix d'echange d'un gold */
  function tradeitBuy(hash) {
    const so = stockOffers();
    if (!so) return null;
    const offers = so.by[hash];
    if (offers && offers.length) return { price: offers[0].trade, src: "ti", qty: offers.reduce((t, o) => t + o.n, 0) };
    const g = so.golds[hash];
    return g ? { price: g.p, src: "ti", qty: g.n } : null;
  }

  /** valeur d'echange d'un gold obtenu : ce que tradeit t'en donne */
  function tradeitValue(hash) {
    const so = stockOffers();
    if (!so) return null;
    const g = so.golds[hash];
    if (g && g.u) return { price: g.u, src: "ti" };
    if (g && so.share) return { price: g.p * so.share, src: "ti", est: true };
    const k = goldMarketRatio();
    const q = k ? engine("market").quote(hash) : null;
    return q ? { price: q.price * k, src: "ti", est: true } : null;
  }

  const tradeitMode = () => state.pay === "tradeit" && !!stockOffers();

  function engine(mode) {
    mode = mode || state.pay;
    if (mode === "tradeit" && !stockOffers()) mode = "market";      // stock pas encore releve
    const key = [mode, state.fee, state.phaseMode, state.floatMode, state.off.join(",")].join("|");
    if (!engines.has(key)) {
      if (engines.size > 3) engines.clear();          // marches + tradeit suffisent
      engines.set(key, TradeupEngine.create(catalog, prices, Object.assign({
        fee: state.fee, phaseMode: state.phaseMode, floatMode: state.floatMode, keyPrice: KEY_PRICE,
        sources: prices.order.filter((k) => !state.off.includes(k)),
      }, mode === "tradeit"
        // tout en monnaie d'echange tradeit, sans frais : son ecart est deja dans la valeur d'echange
        ? { fee: 0, quote: tradeitBuy, valueQuote: tradeitValue } : {})));
    }
    return engines.get(key);
  }

  // ------------------------------------------------------------ en-tete
  function renderHeader() {
    const now = Date.now();
    $("#sources").innerHTML = prices.order.filter((k) => k !== "fb" || !state.off.includes("fb")).map((k) => {
      const s = prices.sources[k];
      if (!s) return "";
      const age = s.updated_at ? (now - new Date(s.updated_at)) / 3600000 : Infinity;
      let cls = "bad", txt = "indisponible";
      if (s.count && s.updated_at) { cls = age < 3 ? "ok" : age < 48 ? "warn" : "bad"; txt = ago(s.updated_at); }
      return `<span class="chip ${cls}"${s.error ? ` title="${esc(s.error)}"` : ""}><b>${esc(s.label)}</b>${esc(txt)}</span>`;
    }).join("") + (stockRaw && stockRaw.updated_at ? (() => {
      const age = (now - new Date(stockRaw.updated_at)) / 3600000;
      return `<span class="chip ${age < 3 ? "ok" : age < 12 ? "warn" : "bad"}" title="Stock et prix d'échange tradeit"><b>tradeit</b>${esc(ago(stockRaw.updated_at))}</span>`;
    })() : "");

    const fx = prices.fx || {};
    const conv = prices.order.filter((k) => prices.sources[k] && prices.sources[k].native === "USD" && k !== "fb").map(srcName);
    $("#fx").innerHTML = base() === "EUR"
      ? `Prix en euros · ${esc(conv.join(", "))} convertis au taux BCE${fx.date ? ` du ${esc(new Date(fx.date).toLocaleDateString("fr-FR"))}` : ""} : 1 $ = ${usdEur().toLocaleString("fr-FR", { maximumFractionDigits: 4 })} €${fx.stale ? " (ancien)" : ""}`
      : `Prix en dollars`;

    const live = MARKET.some((k) => {
      const s = prices.sources[k];
      return s && s.count && s.updated_at && now - new Date(s.updated_at) < 6 * 3600000;
    });
    $("#stale").hidden = live;
    if (!live) {
      $("#stale").innerHTML = `<b>Aucun prix en direct pour l'instant.</b> Aucun marché n'a répondu ces 6 dernières heures ;
        pour ne pas calculer avec des prix périmés, l'ancien relevé Steam est exclu (réactivable dans les options avancées).`;
    }
  }

  // ------------------------------------------------------------ onglets
  function setTab(tab) {
    state.tab = tab; save();
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
    $$(".tab").forEach((s) => { s.hidden = s.id !== "tab-" + tab; });
    render();
  }

  function render() {
    syncToolbar();
    if (state.tab === "builder") renderBuilder();
    else if (state.tab === "target") renderTarget();
    else if (state.tab === "best") renderBest();
    else renderTradeit();
  }

  function syncToolbar() {
    $("#st").checked = state.st;
    $("#cur").value = state.cur;
    $("#mode").value = state.pay;
    $("#mode").querySelector('[value="tradeit"]').disabled = !stockOffers();
    // en echange tradeit, pas de frais de revente : l'ecart de tradeit est dans la valeur d'echange
    $("#fee").value = state.fee;
    $("#fee").disabled = tradeitMode();
    $("#fee").title = tradeitMode() ? "Sans objet en prix tradeit : la valeur d'échange tient déjà compte de l'écart de tradeit" : "";
    $("#phase").value = state.phaseMode;
    $("#formula").value = state.floatMode;
  }

  // ======================================================= CONSTRUCTEUR
  function slotHtml(s, i, r) {
    if (!s) return `<button type="button" class="slot empty" data-slot="${i}"><span>+</span>Ajouter un Covert</button>`;
    const row = r && r.inputs.find((x) => x.__i === i);
    const sk = catalog.coverts[s.name];
    const wear = row ? row.wear : s.wear;
    const fl = s.float != null && s.float !== "" ? `float ${(+s.float).toFixed(4)}` : `float &lt; ${row ? row.float.toFixed(2) : "?"}`;
    const p = row && row.q ? `${money(row.price)} ${srcBadge(row.q, row.hash)}`
      : `<span class="muted">${tradeitMode() ? "pas en stock chez tradeit" : "prix inconnu"}</span>`;
    const col = engine().caseOf(s.name);
    return `<div class="slot filled${state.st ? " st" : ""}" data-slot="${i}" role="button" tabindex="0">
      <button type="button" class="slot-x" data-remove="${i}" aria-label="Retirer">×</button>
      ${img(sk && sk.img, s.name)}
      <div class="slot-n">${state.st ? "StatTrak™ " : ""}${esc(s.name)}</div>
      <div class="slot-w">${esc(SHORT[wear] || wear || "")} · ${fl}</div>
      <div class="slot-p">${p}</div>
      <div class="slot-c">${esc(col ? col.case : "")}</div></div>`;
  }

  /**
   * Item precis du stock tradeit : en prix tradeit, son prix d'echange ; en
   * prix des marches, son float compte mais il est cote au marche.
   */
  function slotInput(s) {
    if (s.ti == null) return s;
    return tradeitMode() ? Object.assign({}, s, { price: s.ti, src: "ti", trade: s.ti }) : Object.assign({}, s, { price: null });
  }

  function evaluateSlots() {
    const filled = state.slots.map((s, i) => (s ? Object.assign({ __i: i }, slotInput(s)) : null)).filter(Boolean);
    const r = engine().evaluate(filled, { st: state.st });
    r.inputs.forEach((row, k) => { row.__i = filled[k].__i; });
    return r;
  }

  function renderBuilder() {
    const r = evaluateSlots();
    $("#slots").innerHTML = state.slots.map((s, i) => slotHtml(s, i, r)).join("");
    $("#b-result").innerHTML = builderResult(r);
  }

  /** rappel du jeu de prix utilise, sous les resultats */
  function payNote(r) {
    if (tradeitMode()) {
      const est = r && r.outcomes ? r.outcomes.filter((o) => o.est).length : 0;
      return `<p class="muted small">Prix tradeit : chaque Covert à son prix d'échange (pile la moins chère, ou l'item précis choisi),
        chaque résultat à ce que tradeit t'en donne en échange, sans frais en plus.${est ? ` ${est} résultat${est > 1 ? "s" : ""} pas en stock chez tradeit : valeur d'échange estimée (marquée ≈).` : ""}</p>`;
    }
    if (state.slots.some((s) => s && s.ti != null)) {
      return `<p class="muted small">Items du stock tradeit : leur float est pris en compte, mais en prix des marchés ils sont cotés au marché.
        Passe le sélecteur « Prix » sur tradeit pour les compter à leur prix d'échange.</p>`;
    }
    return "";
  }

  /** cartes des resultats possibles d'un contrat */
  function ocCards(list) {
    return list.map((o) => {
      const cls = (o.profit == null ? "" : o.profit >= 0 ? "w" : "l") + (o.isTarget ? " t" : "");
      const fl = o.float != null ? ` · ${o.float.toFixed(4)}` : "";
      return `<div class="oc ${cls}">
        ${img(o.img, o.name)}
        <div class="oc-n">${state.st && catalog.golds[o.name].st ? "StatTrak™ " : ""}${esc(short(o.name))}</div>
        <div class="oc-w">${esc(o.wear ? SHORT[o.wear] : "sans usure")}${fl}${o.cappedBy ? ` · coté au prix ${esc(SHORT[o.cappedBy])}` : ""}</div>
        <div class="oc-r"><span class="oc-p">${pct(o.p)}</span><span class="oc-v"${o.est ? ' title="Pas en stock chez tradeit : valeur d\'échange estimée"' : ""}>${o.net != null ? (o.est ? "≈ " : "") + money(o.net) : "?"}</span></div>
        <div class="oc-g ${o.profit == null ? "muted" : o.profit >= 0 ? "win" : "loss"}">${o.profit != null ? `${signed(o.profit)} <small>(${pct(o.roi, true)})</small>` : (o.net == null ? "sans prix actuel" : "")}</div>
      </div>`;
    }).join("");
  }

  function builderResult(r) {
    if (!r.n) {
      return `<div class="panel empty">Ajoute des Coverts pour voir tous les résultats possibles, avec leur chance, leur prix et ton gain ou ta perte.
        <div class="btns" style="justify-content:center;margin-top:12px">
          <button type="button" class="btn" data-go="best">Voir les contrats les plus rentables</button>
          <button type="button" class="btn ghost" data-go="target">Partir d'un gold visé</button></div></div>`;
    }
    const errs = r.errors.length ? `<div class="warn-box">${r.errors.map(esc).join("<br>")}</div>` : "";
    let head = "";
    if (!r.complete) {
      head = `<div class="panel"><b>Encore ${5 - r.n} Covert${5 - r.n > 1 ? "s" : ""} à ajouter</b> pour un contrat valide.
        <span class="muted">Aperçu ci-dessous des golds possibles avec les inputs déjà choisis.</span></div>`;
    } else if (r.cost == null) {
      head = `<div class="panel">Un input n'a pas de prix actuel : choisis une autre usure ou indique ton prix pour obtenir la rentabilité.</div>`;
    } else if (r.ev != null) {
      const ar = (v) => v >= 0 ? "win" : "loss";
      head = `<div class="kpis">
        <div class="kpi"><span>Coût du contrat</span><b>${money(r.cost)}</b><small>5 Coverts${state.st ? " StatTrak™" : ""}${tradeitMode() ? ", prix d'échange" : ""}</small></div>
        <div class="kpi"><span>Valeur moyenne</span><b>${money(r.ev)}</b><small>${tradeitMode() ? "ce que tradeit t'en donne" : `revente nette, frais ${esc(state.fee)} %`}</small></div>
        <div class="kpi ${ar(r.profit)}"><span>Profit moyen</span><b>${signed(r.profit)}</b><small>${pct(r.roi, true)} par contrat</small></div>
        <div class="kpi ${r.pWin >= 0.5 ? "win" : ""}"><span>Chance de profit</span><b>${pct(r.pWin)}</b><small>${pct(1 - r.pWin)} de perdre</small></div>
        <div class="kpi"><span>Meilleur cas</span><b class="win">${r.best ? signed(r.best.profit) : "—"}</b><small>${esc(r.best ? short(r.best.name) : "")}</small></div>
        <div class="kpi"><span>Pire cas</span><b class="loss">${r.worst ? signed(r.worst.profit) : "—"}</b><small>${esc(r.worst ? short(r.worst.name) : "")}</small></div>
      </div>`;
      const seg = r.outcomes.slice().sort((a, b) => (a.profit == null) - (b.profit == null) || (a.profit || 0) - (b.profit || 0))
        .map((o) => `<i class="${o.profit == null ? "u" : o.profit >= 0 ? "w" : "l"}" style="width:${(o.p * 100).toFixed(3)}%" title="${esc(short(o.name))} : ${pct(o.p)}"></i>`).join("");
      head += `<div class="probbar" aria-label="Répartition des chances : perte en rouge, profit en vert">${seg}</div>
        <div class="bar-legend"><span class="loss">perte ${pct(1 - r.pWin)}</span><span class="win">profit ${pct(r.pWin)}</span></div>`;
    }
    const xTxt = r.x != null ? `position moyenne des inputs ${(Math.max(0, r.x)).toFixed(4)}` : "";
    const sorters = {
      value: (a, b) => (b.net || 0) - (a.net || 0),
      chance: (a, b) => b.p - a.p || (b.net || 0) - (a.net || 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    const list = r.outcomes.slice().sort(sorters[state.ocSort] || sorters.value);
    const cards = ocCards(list);
    return errs + head + payNote(r) + `
      <div class="res-head"><h2>Résultats possibles (${r.outcomes.length})</h2>
        <label>Trier <select id="oc-sort">
          <option value="value"${state.ocSort === "value" ? " selected" : ""}>par valeur</option>
          <option value="chance"${state.ocSort === "chance" ? " selected" : ""}>par chance</option>
          <option value="name"${state.ocSort === "name" ? " selected" : ""}>par nom</option></select></label></div>
      <p class="muted small">${xTxt}${r.unpriced ? ` · ${r.unpriced} résultat(s) sans prix actuel, comptés 0 €` : ""}</p>
      <div class="ocgrid">${cards}</div>`;
  }

  // ----------------------------------------------------------- selecteur
  const pk = { slot: 0, name: null, wear: null, float: "", price: "", ti: null };

  function openPicker(i) {
    pk.slot = i;
    const s = state.slots[i];
    pk.name = s ? s.name : null;
    pk.wear = s ? s.wear : null;
    pk.float = s && s.float != null ? s.float : "";
    pk.price = s && s.price != null ? s.price : "";
    pk.ti = s && s.ti != null ? s.ti : null;
    $("#pk-title").textContent = `Case ${i + 1} : choisir un Covert`;
    renderPickerList();
    renderPickerDetail();
    const d = $("#picker");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    $("#pk-q").focus();               // tout de suite : une saisie rapide ne doit pas changer de champ
  }
  function closePicker() {
    const d = $("#picker");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  /** prix d'achat d'un input selon le mode de paiement choisi */
  const priceFor = (hash) => engine().quote(hash);

  function cheapest(name) {
    const sk = catalog.coverts[name];
    let best = null;
    for (const w of sk.wears) {
      const q = priceFor(TradeupEngine.hashName(name, w, state.st));
      if (q && (!best || q.price < best.price)) best = q;
    }
    return best;
  }

  function renderPickerList() {
    const q = $("#pk-q").value.trim().toLowerCase();
    const cs = $("#pk-case").value;
    const items = [];
    for (const col of catalog.collections) {
      if (cs && col.case !== cs) continue;
      for (const name of col.inputs) {
        const sk = catalog.coverts[name];
        if (state.st && !sk.st) continue;
        if (q && !(name.toLowerCase().includes(q) || col.case.toLowerCase().includes(q))) continue;
        items.push({ name, col, sk });
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    $("#pk-list").innerHTML = items.length ? items.map(({ name, col, sk }) => {
      const c = cheapest(name);
      return `<button type="button" class="pk-item${name === pk.name ? " sel" : ""}" data-pick="${esc(name)}">
        ${img(sk.img, name)}<b>${esc(name)}</b><small>${esc(col.case)}</small>
        <span class="p">${c ? "dès " + money(c.price) : '<span class="muted">pas en vente</span>'}</span></button>`;
    }).join("") : `<p class="muted">Aucun Covert ne correspond.</p>`;
  }

  function renderPickerDetail() {
    const box = $("#pk-detail");
    if (!pk.name) { box.innerHTML = `<p class="muted">Choisis un Covert à gauche.</p>`; return; }
    const sk = catalog.coverts[pk.name];
    if (!pk.wear || !sk.wears.includes(pk.wear)) {
      // par defaut l'usure la moins chere
      let best = null;
      for (const w of sk.wears) {
        const q = priceFor(TradeupEngine.hashName(pk.name, w, state.st));
        if (q && (!best || q.price < best.q.price)) best = { w, q };
      }
      pk.wear = best ? best.w : sk.wears[sk.wears.length - 1];
    }
    const wears = sk.wears.map((w) => {
      const hash = TradeupEngine.hashName(pk.name, w, state.st);
      const q = priceFor(hash);
      return `<button type="button" class="wear-btn${w === pk.wear ? " sel" : ""}" data-wear="${esc(w)}">
        <b>${esc(SHORT[w])}</b><small>${q ? money(q.price) : "—"}</small></button>`;
    }).join("");
    const empty = state.slots.filter((s, i) => !s && i !== pk.slot).length;
    const chosen = pk.ti != null ? `<p class="ti-pick small">Item tradeit choisi : <b>${esc(SHORT[pk.wear])} ${(+pk.float).toFixed(4)}</b>,
        ${money(pk.ti)} en échange${tradeitMode() ? "" : " (compté au prix des marchés tant que « Prix » n'est pas sur tradeit)"}.</p>` : "";
    box.innerHTML = `${img(sk.img, pk.name)}
      <div><b>${state.st ? "StatTrak™ " : ""}${esc(pk.name)}</b><br><span class="muted small">${esc(engine().caseOf(pk.name).case)} · float ${sk.min}–${sk.max}</span></div>
      <div><span class="muted small">Usure</span><div class="wears">${wears}</div></div>
      ${pickerStock(sk)}${chosen}
      <label>Float exact (facultatif)
        <input id="pk-float" type="number" step="any" min="${sk.min}" max="${sk.max}" placeholder="${sk.min} – ${sk.max}" value="${esc(pk.float)}" inputmode="decimal"></label>
      <label>Ton prix (facultatif)
        <input id="pk-price" type="number" step="0.01" min="0" placeholder="${pk.ti != null ? "prix tradeit" : "prix du marché"}" value="${esc(pk.price)}" inputmode="decimal"></label>
      <p class="muted small">Sans float exact, on prend le pire float de l'usure choisie. Ton prix remplace le prix du marché (item déjà possédé, autre site).</p>
      <div class="pk-actions">
        <button type="button" class="btn" id="pk-put">Mettre dans la case ${pk.slot + 1}</button>
        ${empty ? `<button type="button" class="btn ghost" id="pk-fill">Remplir aussi les ${empty} case${empty > 1 ? "s" : ""} vide${empty > 1 ? "s" : ""}</button>` : ""}
      </div>`;
  }

  function pickerValue() {
    const sk = catalog.coverts[pk.name];
    let f = $("#pk-float") ? $("#pk-float").value.trim().replace(",", ".") : "";
    let price = $("#pk-price") ? $("#pk-price").value.trim().replace(",", ".") : "";
    f = f === "" ? null : Math.min(Math.max(parseFloat(f), sk.min), sk.max);
    price = price === "" ? null : Math.max(0, parseFloat(price));
    if (f != null && !isFinite(f)) f = null;
    if (price != null && !isFinite(price)) price = null;
    // l'item tradeit choisi tient tant que son float et son prix ne sont pas modifies
    const ti = pk.ti != null && f != null && pk.float !== "" && Math.abs(f - +pk.float) < 1e-9 && price == null ? pk.ti : null;
    return { name: pk.name, wear: pk.wear, float: f, price, ti };
  }

  /** stock tradeit du Covert choisi : une ligne par pile, ses plus bas floats cliquables */
  function pickerStock(sk) {
    const so = stockOffers();
    if (!so) return "";
    const rows = [];
    for (const w of sk.wears) {
      const hash = TradeupEngine.hashName(pk.name, w, state.st);
      for (const o of so.by[hash] || []) {
        const btns = o.f.map((f) => {
          const sel = pk.ti === o.trade && pk.float !== "" && Math.abs(+pk.float - f) < 1e-12;
          return `<button type="button" class="fl${sel ? " sel" : ""}" data-tif="${f}" data-tiw="${esc(w)}" data-tip="${o.trade}">${f.toFixed(4)}</button>`;
        }).join("");
        const more = !o.f.length ? `<span class="muted small">floats pas encore relevés</span>`
          : o.n > o.f.length ? `<span class="muted small">+ ${o.n - o.f.length} jusqu'à ${o.hi.toFixed(4)}</span>` : "";
        rows.push(`<div class="pk-offer"><div><b>${esc(SHORT[w])}</b><span class="muted small">${o.n} en stock${o.lock ? ` · bloqué ${o.lock} j` : ""}${floatAge(o)}</span>
            <span class="p">${money(o.trade)} <small class="muted">en échange</small></span></div>
          <div class="fls">${btns}${more}</div></div>`);
      }
    }
    return `<div class="pk-stock"><span class="muted small">Stock tradeit : même prix d'échange pour toute une pile, prends le plus bas float.</span>
      ${rows.length ? rows.join("") : `<p class="muted small" style="margin:0">Pas en stock chez tradeit${state.st ? " en StatTrak™" : ""}.</p>`}</div>`;
  }

  /** remplit les cases vides avec v ; un item tradeit est unique : les cases suivantes prennent les floats suivants de sa pile */
  function fillEmpty(v) {
    if (v.ti == null) { state.slots = state.slots.map((s) => s || Object.assign({}, v)); return; }
    const so = stockOffers();
    const hash = TradeupEngine.hashName(v.name, v.wear, state.st);
    const offer = so && (so.by[hash] || []).find((o) => o.trade === v.ti);
    const used = new Set(state.slots.filter((s) => s && s.ti === v.ti && s.name === v.name).map((s) => s.float));
    const free = offer ? offer.f.filter((f) => !used.has(f) && f !== v.float) : [];
    state.slots = state.slots.map((s) => s || (free.length ? Object.assign({}, v, { float: free.shift() }) : null));
  }

  // ========================================================== GOLD VISE
  // ---- cible : un gold, ou toutes les finitions d'un couteau / de gants
  const ALL = " (toutes finitions)";
  const typeOf = (n) => n.split(" | ")[0];                 // "★ Butterfly Knife | Fade" -> "★ Butterfly Knife"
  const baseGold = (h) => h.replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, "").replace("★ StatTrak™ ", "★ ");
  function targetInfo(t) {
    if (catalog.golds[t]) return { names: [t], single: t, type: null };
    if (t && t.endsWith(ALL)) {
      const type = t.slice(0, -ALL.length);
      const names = Object.keys(catalog.golds).filter((n) => typeOf(n) === type);
      if (names.length > 1) return { names, single: null, type };
    }
    return null;
  }
  /** nom choisi dans la liste, sans tenir compte des majuscules */
  function matchTarget(v) {
    if (targetInfo(v)) return v;
    const low = v.toLowerCase();
    const g = Object.keys(catalog.golds).find((n) => n.toLowerCase() === low);
    if (g) return g;
    const types = [...new Set(Object.keys(catalog.golds).map(typeOf))].map((t) => t + ALL);
    return types.find((t) => t.toLowerCase() === low && targetInfo(t)) || null;
  }

  /**
   * Avec le stock tradeit : pour chaque caisse qui donne la cible, deux
   * contrats de 5 items precis (100 % de la caisse) :
   *  - le moins cher pour l'avoir : minimise (cout - valeur des autres
   *    resultats) / chance. La chance ne dependant que de la caisse, c'est le
   *    contrat le plus rentable quand la cible ne vaut rien (optimiseur exact) ;
   *  - le plus rentable en moyenne.
   */
  let tgMemo = { key: "", v: null };
  function exactContracts(ti, st) {
    const so = stockOffers();
    if (!so) return null;
    const key = [ti.names.join("|"), st, state.minWear, state.phaseMode, state.floatMode, state.off.join(","), stockRaw.updated_at].join("§");
    if (tgMemo.key === key) return tgMemo.v;
    const tset = new Set(ti.names);
    const real = engine("tradeit");
    const zero = TradeupEngine.create(catalog, prices, {
      fee: 0, phaseMode: state.phaseMode, floatMode: state.floatMode,
      sources: prices.order.filter((k) => !state.off.includes(k)),
      quote: tradeitBuy, valueQuote: (h) => (tset.has(baseGold(h)) ? { price: 0, src: "ti" } : tradeitValue(h)),
    });
    // usure minimale d'une cible unique : plafond de la position moyenne des inputs
    let maxX;
    const g = ti.single ? catalog.golds[ti.single] : null;
    if (g && g.wears.length && state.minWear !== "any") {
      const lim = catalog.wears.find((w) => w[0] === state.minWear)[2];
      maxX = (lim - g.min) / (g.max - g.min);
    }
    const sum = (r, col) => {
      const pT = r.outcomes.reduce((t, o) => t + (tset.has(o.name) ? o.p : 0), 0);
      const vo = r.outcomes.reduce((t, o) => t + (tset.has(o.name) ? 0 : o.p * (o.net || 0)), 0);
      r.outcomes.forEach((o) => { o.isTarget = tset.has(o.name); });
      return Object.assign(r, { pT, vo, expected: pT > 0 ? (r.cost - vo) / pT : Infinity, case: col.case });
    };
    const out = [];
    for (const col of catalog.collections) {
      const p = real.poolOf(col, st).reduce((t, o) => t + (tset.has(o.name) ? o.w : 0), 0);
      if (!p) continue;
      const listings = {};
      for (const name of col.inputs) {
        if (st && !catalog.coverts[name].st) continue;
        for (const w of catalog.coverts[name].wears) {
          const h = TradeupEngine.hashName(name, w, st);
          if ((so.listings[h] || []).length) listings[h] = so.listings[h];
        }
      }
      const opt = { listings, st, fillers: 0, src: "ti", maxX };
      const c0 = zero.stockContracts(opt)[0];
      if (!c0) continue;
      const items = (r) => r.inputs.map((x) => ({ name: x.name, float: x.float, price: x.price, trade: x.q.trade, src: "ti" }));
      const cheap = sum(real.evaluate(items(c0), { st }), col);
      if (cheap.ev == null) continue;
      const r1 = real.stockContracts(opt)[0];
      const rich = r1 && items(r1).some((x, i) => x.float !== cheap.inputs[i].float || x.name !== cheap.inputs[i].name) ? sum(r1, col) : null;
      out.push({ col, p, cheap, rich });
    }
    out.sort((a, b) => a.cheap.expected - b.cheap.expected);
    tgMemo = { key, v: out };
    return out;
  }
  let tgList = [];
  const tgAt = (k) => { const [i, w] = k.split(":"); const e = tgList[+i]; return e && e[w]; };

  function renderTarget() {
    const ti = targetInfo(state.target);
    $("#target").value = state.target;
    const g = ti && ti.single ? catalog.golds[ti.single] : null;
    const wears = g ? g.wears : [];
    $("#wear").innerHTML = `<option value="any">Peu importe</option>` +
      wears.slice(0, -1).map((w, i) => `<option value="${esc(w)}">${esc(w)}${i ? " ou mieux" : ""}</option>`).join("");
    if (![...$("#wear").options].some((o) => o.value === state.minWear)) state.minWear = "any";
    $("#wear").value = state.minWear;
    $("#wear").disabled = !wears.length;
    if (!ti) { $("#t-result").innerHTML = `<div class="panel empty">Choisis un couteau ou des gants, une finition précise ou « toutes finitions ».</div>`; return; }

    const st = state.st && ti.names.some((n) => catalog.golds[n].st);
    const res = engine().analyze(ti.single || ti.names, { st, minWear: g ? state.minWear : "any" });
    const tset = new Set(ti.names);
    const stName = (n) => (st ? n.replace("★ ", "★ StatTrak™ ") : n);
    const label = g ? stName(state.target) : `${stName(ti.type)} — n'importe quelle finition`;
    const heroImg = g ? g.img : (catalog.golds[ti.type] || catalog.golds[ti.names[0]]).img;
    const share = (cs) => {
      const col = catalog.collections.find((c) => c.case === cs);
      return engine().poolOf(col, st).reduce((t, o) => t + (tset.has(o.name) ? o.w : 0), 0);
    };
    const casesTxt = res.cases.length
      ? `Par trade-up depuis : <b>${res.cases.map((c) => esc(c) + (g ? "" : ` (${pct(share(c))} par Covert)`)).join(", ")}</b>`
      : "Aucune caisse ne le donne par trade-up dans ce mode.";
    const phases = g && g.phases.length ? `<p class="muted small">Phases : ${esc(g.phases.join(", "))}. Prix de la phase la moins chère ; une phase rare est un bonus non compté.</p>` : "";
    const many = g ? "" : `<p class="muted small">${ti.names.length} finitions possibles ; dans une caisse, chaque finition a la même chance.</p>`;
    const hero = `<div class="panel hero">${img(heroImg, label)}<div><h2>${esc(label)}</h2>
      <p>${casesTxt}</p>${phases}${many}
      ${state.st && !st ? '<p class="warn-box" style="margin:8px 0 0">Pas de version StatTrak™ (gants) : calcul en version normale.</p>' : ""}</div></div>`;

    const buy = res.methods.find((m) => m.kind === "buy");
    const unbox = res.methods.filter((m) => m.kind === "unbox");
    const notes = res.notes.map((n) => floatNote(n, res)).join("");
    const exact = tradeitMode() ? exactContracts(ti, st) : null;
    tgList = exact || [];
    const perWear = res.methods.filter((m) => m.kind === "tradeup");
    const bestTu = exact ? (exact[0] ? exact[0].cheap.expected : null) : (perWear[0] ? perWear[0].expected : null);
    if (!buy && bestTu == null) {
      $("#t-result").innerHTML = hero + notes + `<div class="panel empty">Aucune méthode chiffrable avec les prix actuels${tradeitMode() ? " de tradeit" : " des sites cochés"}.</div>`;
      return;
    }

    let buyCard = "";
    if (buy) {
      const others = g ? "" : buy.rows.filter((r) => r.q && r !== buy.best).sort((a, b) => a.q.price - b.q.price).slice(0, 4)
        .map((r) => `${esc(short(r.hash))} ${money(r.q.price)}`).join(" · ");
      const isBest = bestTu == null || buy.cost <= bestTu;
      buyCard = `<div class="method${isBest ? " best" : ""}"><div>
          <h3>Acheter directement${isBest ? " · le moins cher" : ""}</h3>
          <div class="meta-row"><span>${esc(buy.best.hash)}</span><span>${srcBadge(buy.best.q, buy.best.hash)}</span><span>aucun risque</span></div>
          ${others ? `<p class="muted small" style="margin:6px 0 0">Ensuite : ${others}</p>` : ""}</div>
          <div class="big">${money(buy.cost)}<small>${tradeitMode() ? "prix d'échange" : "prix actuel"}</small></div></div>`;
    }

    let cards;
    if (exact) {
      const row = (r, k, title) => {
        const its = r.inputs.map((x) => `<div class="ti-it" title="${esc(x.case)}">${img(x.img, x.name)}<b>${esc(x.name)}</b>
            <small>${esc(SHORT[x.wear])} · ${x.float.toFixed(4)}</small><small>${money(x.price)}</small></div>`).join("");
        const cls = r.profit >= 0 ? "win" : "loss";
        return `<div class="tg-row"><h4>${title}</h4><div class="ti-items">${its}</div>
          <div class="meta-row"><span>contrat <b>${money(r.cost)}</b></span><span>chance ${g ? "de la cible" : "d'en avoir un"} <b>${pct(r.pT)}</b></span>
            <span>coût moyen pour l'avoir <b>${money(r.expected)}</b></span><span>valeur moyenne <b>${money(r.ev)}</b></span>
            <span>profit moyen <b class="${cls}">${signed(r.profit)}</b> (${pct(r.roi, true)})</span><span>chance de profit <b>${pct(r.pWin)}</b></span></div>
          <div class="btns" style="margin-top:6px"><button type="button" class="btn sm ghost" data-tgres="${k}">Résultats (${r.outcomes.length})</button>
            <button type="button" class="btn sm" data-tgload="${k}">Ouvrir dans le constructeur</button></div>
          <div class="ti-oc" data-tgbox="${k}" hidden></div></div>`;
      };
      cards = exact.map((e, i) => {
        const isBest = i === 0 && (!buy || e.cheap.expected < buy.cost);
        return `<div class="method tg${isBest ? " best" : ""}"><div>
          <h3>Trade-up 100 % ${esc(e.col.case)} · ${pct(e.p)} par Covert${isBest ? " · le moins cher en moyenne" : ""}</h3>
          ${row(e.cheap, `${i}:cheap`, "Le moins cher pour l'avoir")}
          ${e.rich ? row(e.rich, `${i}:rich`, "Le plus rentable en moyenne") : ""}</div>
          <div class="big">${money(e.cheap.expected)}<small>coût moyen pour l'avoir</small></div></div>`;
      }).join("") || `<div class="panel empty">Aucun Covert de ces caisses en stock chez tradeit, avec un float connu${state.minWear !== "any" && g ? " assez bas" : ""}.</div>`;
    } else {
      const best = perWear[0];
      cards = perWear.map((m) => {
        const isBest = m === best && (!buy || m.expected < buy.cost);
        const thumbs = m.inputs.map((k) => `<div class="thumb">${img(catalog.coverts[k.name].img, k.name)}${k.n}× ${esc(SHORT[k.wear])}</div>`).join("");
        return `<div class="method${isBest ? " best" : ""}"><div>
          <h3>${esc(m.label)}${isBest ? " · le moins cher en moyenne" : ""}</h3>
          <div class="thumbs">${thumbs}</div>
          <div class="meta-row"><span>contrat <b>${money(m.cost)}</b></span><span>chance <b>${pct(m.p)}</b></span>
            <span><b>${num(m.tries)}</b> contrats en moyenne</span><span>valeur moyenne <b>${money(m.ev)}</b></span>
            ${g ? `<span>cible ${esc(m.targetWear || "")}</span>` : ""}</div>
          <div class="btns" style="margin-top:8px"><button type="button" class="btn sm" data-load='${esc(JSON.stringify(m.inputs.map((k) => [k.name, k.wear, k.n])))}'>Ouvrir dans le constructeur</button></div>
        </div><div class="big">${money(m.expected)}<small>coût moyen pour l'avoir</small></div></div>`;
      }).join("");
    }

    let verdict = "";
    if (buy && bestTu != null) {
      verdict = buy.cost <= bestTu
        ? `L'achat direct est <b>${(bestTu / buy.cost).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}× moins cher</b> que le meilleur trade-up pour ${g ? "avoir cette cible précise" : "en avoir un"}.`
        : `Le trade-up revient en moyenne <b>${money(buy.cost - bestTu)} moins cher</b> que l'achat direct, avec du risque.`;
    } else if (!buy) {
      verdict = `<span class="loss">Aucune offre actuelle pour l'acheter directement</span> : impossible de comparer avec l'achat.`;
    }
    const how = exact
      ? `Contrats calculés avec les items <b>précis</b> du stock tradeit (float exact, plus bas floats de chaque pile), tout en prix d'échange.
         « Coût moyen pour l'avoir » = ce que tu dépenses en moyenne avant de tenir ${g ? "la cible" : "l'un d'eux"}, en échangeant au passage les autres résultats chez tradeit.
         ${exact.some((e) => e.p >= 0.999) ? "Quand la chance est de 100 %, c'est simplement le prix du contrat : tu l'as à coup sûr, mais la finition et l'usure tombent au hasard (voir Résultats)." : ""}`
      : `« Coût moyen pour l'avoir » = ce que tu dépenses en moyenne avant de tenir ${g ? "la cible" : "l'un d'eux"}, ${tradeitMode()
        ? "en échangeant au passage les autres résultats chez tradeit (prix d'échange, sans frais)"
        : `en revendant au passage les autres résultats (frais ${esc(state.fee)} %)`}.`;
    const unboxLine = unbox.length ? `<p class="muted small">Pour comparaison, l'ouvrir dans une caisse coûterait ${money(unbox[0].expected, 0)} en moyenne (${esc(unbox[0].case)}, ${pct(unbox[0].p)} par ouverture, clé ${money(KEY_PRICE)}).</p>` : "";
    $("#t-result").innerHTML = hero + notes + `<div class="panel"><p style="margin:0 0 10px">${verdict}</p><div class="methods">${buyCard}${cards}</div>
      <p class="muted small">${how}</p>${unboxLine}</div>`;
  }

  function floatNote(n, res) {
    if (n.kind !== "float") return "";
    const covs = [];
    for (const col of catalog.collections) {
      if (!res.cases.includes(col.case)) continue;
      for (const name of col.inputs) {
        const sk = catalog.coverts[name];
        const f = state.floatMode === "raw" ? n.xNeeded : sk.min + n.xNeeded * (sk.max - sk.min);
        covs.push(`${esc(name)} ≤ ${f.toFixed(4)}`);
      }
    }
    return `<div class="warn-box"><b>Impossible de garantir « ${esc(res.minWear)} ou mieux » en achetant par palier d'usure.</b>
      Il faut des floats choisis un par un (filtre de float sur CSFloat), par input : ${covs.join(" · ")}.</div>`;
  }

  // ===================================================== MEILLEURS CONTRATS
  function renderBest() {
    $("#best-sort").value = state.bestSort;
    $("#best-budget").value = state.bestBudget;
    const budget = parseFloat(String(state.bestBudget).replace(",", "."));
    let b = isFinite(budget) && budget > 0 ? budget : 0;
    if (b && state.cur !== base()) b = state.cur === "EUR" ? b / usdEur() : b * usdEur();
    const list = engine().bestContracts({ st: state.st, budget: b, sort: state.bestSort });
    if (!list.length) {
      $("#best-list").innerHTML = `<div class="panel empty">Aucun contrat chiffrable${b ? " dans ce budget" : ""} avec les prix actuels.</div>`;
      return;
    }
    const good = list.filter((r) => r.profit > 0).length;
    const cards = list.map((r) => {
      const groups = [];
      for (const k of r.inputs) {
        const g = groups.find((x) => x.name === k.name && x.wear === k.wear);
        if (g) g.n++; else groups.push({ name: k.name, wear: k.wear, n: 1 });
      }
      const thumbs = groups.map((k) => `<div class="thumb">${img(catalog.coverts[k.name].img, k.name)}${k.n}× ${esc(SHORT[k.wear])}</div>`).join("");
      const cls = r.profit >= 0 ? "win" : "loss";
      return `<div class="bc">${img(r.caseImg, r.case)}
        <div><h3>${esc(r.case)}</h3><div class="thumbs">${thumbs}</div>
          <div class="meta-row"><span>coût <b>${money(r.cost)}</b></span><span>valeur moyenne <b>${money(r.ev)}</b></span>
            <span>rentabilité <b class="${cls}">${pct(r.roi, true)}</b></span><span>chance de profit <b>${pct(r.pWin)}</b></span>
            <span>meilleur cas <b class="win">${r.best ? signed(r.best.profit) : "—"}</b></span></div></div>
        <div class="side"><b class="${cls}">${signed(r.profit)}</b><span class="muted small">profit moyen</span>
          <button type="button" class="btn sm" data-load='${esc(JSON.stringify(groups.map((k) => [k.name, k.wear, k.n])))}'>Ouvrir</button></div></div>`;
    }).join("");
    $("#best-list").innerHTML = `<p class="muted small">${good} caisse${good > 1 ? "s" : ""} sur ${list.length} avec un contrat rentable en moyenne${state.st ? " (StatTrak™)" : ""}${tradeitMode() ? ", en prix d'échange tradeit" : ""}.</p>${cards}`;
  }

  // ========================================================= TRADEIT
  async function loadInventoryFile() {
    if (invFile !== null) return invFile;
    try {
      const r = await fetch("data/inventory.enc.json", { cache: "no-store" });
      invFile = r.ok ? await r.json() : false;
    } catch (e) { invFile = false; }
    return invFile;
  }

  /** inventaire dechiffre -> lignes en valeur d'echange, dans la devise des prix */
  function prepareInventory(raw) {
    const items = raw.items.map((it) => ({
      key: it.name, name: it.name, qty: it.qty || 1, img: it.img,
      user: usdToBase((it.user || 0) / 100),               // ce que tradeit t'accorde, par unite
    })).filter((it) => it.user > 0);
    items.sort((a, b) => b.user * b.qty - a.user * a.qty);
    return { updated_at: raw.updated_at, items };
  }

  async function unlock(pass, remember) {
    const file = await loadInventoryFile();
    const raw = await TradeupVault.decrypt(file, pass);
    inv = prepareInventory(raw);
    if (remember) mem.set("invpass", pass); else mem.del("invpass");
  }

  async function renderTradeit() {
    const root = $("#ti-root");
    const file = await loadInventoryFile();
    if (file && !inv) {
      const saved = mem.get("invpass", null);
      if (saved) {
        try { await unlock(saved, true); } catch (e) { mem.del("invpass"); }
      }
    }
    const view = ["contracts", "stock", "inv"].includes(state.tiView) ? state.tiView : "contracts";
    const seg = [["contracts", "Meilleurs contrats"], ["stock", "Coverts en stock"], ["inv", "Mon inventaire"]]
      .map(([k, l]) => `<button type="button" data-tiview="${k}" aria-pressed="${k === view}">${l}</button>`).join("");
    const body = view === "stock" ? tiStock() : view === "inv" ? tiInventory(file) : tiContracts();
    root.innerHTML = tiHead(file) + `<div class="seg ti-seg" role="group" aria-label="Vue tradeit">${seg}</div>` + body;
  }

  const SETUP = `<p>Le relevé automatique lit ton inventaire via tradeit avec ton identifiant Steam (inventaire Steam public, aucune connexion),
      récupère la valeur d'échange exacte que tradeit t'accorde pour chaque item, puis <b>chiffre</b> le tout avec une phrase secrète
      avant de le publier. Seul ton navigateur peut le déchiffrer.</p>
    <ol class="steps">
      <li>Dépôt GitHub → <b>Settings → Secrets and variables → Actions</b> → <i>New repository secret</i> :
        nom <code>STEAM_ID</code>, valeur = ton identifiant Steam 64 bits (17 chiffres, commence par 7656…).
        En secret, il reste masqué dans les logs publics du dépôt.</li>
      <li>Deuxième secret : nom <code>INVENTORY_KEY</code>, valeur = une phrase secrète de ton choix (elle chiffre l'inventaire).</li>
      <li>Attends le prochain relevé (30 min max), puis reviens ici et entre la phrase secrète.</li>
    </ol>`;

  /** haut de l'onglet : ton solde d'echange, ou deverrouillage, ou mise en place */
  function tiHead(file) {
    if (!file) {
      return `<div class="panel"><details><summary><b>Ton inventaire tradeit n'est pas encore relevé</b>
        <span class="muted small">— les contrats restent calculés, sans ton solde</span></summary>${SETUP}</details></div>`;
    }
    if (!inv) {
      return `<div class="panel"><h2>Inventaire tradeit chiffré</h2>
        <p class="muted small">Relevé ${esc(ago(file.updated_at))}. Entre ta phrase secrète (secret <code>INVENTORY_KEY</code>) : le déchiffrement se fait dans ton navigateur.
        Sans elle, les contrats restent calculés, sans ton solde.</p>
        <form id="ti-unlock" class="ti-form">
          <label>Phrase secrète <input id="ti-pass" type="password" autocomplete="current-password" required></label>
          <label class="switch" style="flex:0 0 auto"><input type="checkbox" id="ti-remember" checked><span>Se souvenir sur cet appareil</span></label>
          <button class="btn" type="submit">Déverrouiller</button>
        </form><p id="ti-err" class="loss small"></p></div>`;
    }
    const b = balance(), total = inv.items.reduce((t, it) => t + it.qty, 0);
    return `<div class="kpis">
        <div class="kpi best"><span>Ton solde d'échange</span><b>${money(b.user)}</b><small>ce que tradeit t'accorde (items cochés)</small></div>
        <div class="kpi"><span>Items cochés</span><b>${num(b.n)}</b><small>sur ${num(total)} dans ton inventaire</small></div>
        <div class="kpi"><span>Relevé</span><b>${esc(ago(inv.updated_at))}</b><small>${inv.items.length} types d'items</small></div>
      </div>`;
  }

  const noStock = () => `<div class="panel empty">Le stock tradeit n'est pas encore relevé : il l'est automatiquement toutes les 30 minutes, item par item.</div>`;
  function stockAge() {
    const h = stockRaw && stockRaw.updated_at ? (Date.now() - new Date(stockRaw.updated_at)) / 3600000 : Infinity;
    const so = stockOffers();
    const cov = so && so.known < so.piles ? ` ; floats lus pour ${num(so.known)} piles sur ${num(so.piles)}, le reste suit aux prochains relevés` : "";
    return `Stock relevé ${esc(ago(stockRaw.updated_at))}${cov}` +
      (h > 2 ? ` <b class="loss">— ancien, des items ont pu partir</b>` : "");
  }
  /** floats d'une pile relevés il y a longtemps : le dire */
  function floatAge(o) {
    if (!o.at || !o.f.length) return "";
    const h = (Date.now() - new Date(o.at)) / 3600000;
    return h >= 1 ? ` · floats lus ${esc(ago(o.at))}` : "";
  }
  /** part des couteaux et gants dont la valeur d'echange est lue chez tradeit */
  function goldNote() {
    const so = stockOffers();
    if (!so) return "";
    const exact = Object.values(so.golds).filter((g) => g.u).length;
    return `Valeur d'échange lue chez tradeit pour ${num(exact)} couteaux et gants (toutes usures confondues) ;
      un résultat que tradeit n'a pas en stock est estimé et marqué ≈.`;
  }

  // ---------------------------------------------- contrats sur le stock
  let tiList = null, tiKey = "";
  function stockList(budget) {
    const so = stockOffers();
    const key = [state.st, state.tiMix, state.tiSort, budget, state.phaseMode, state.floatMode,
                 state.off.join(","), stockRaw.updated_at].join("|");
    if (key !== tiKey) {
      tiList = engine("tradeit").stockContracts({ listings: so.listings, st: state.st,
        fillers: +state.tiMix, budget, sort: state.tiSort, src: "ti" });
      tiKey = key;
    }
    return tiList;
  }

  function tiContracts() {
    const so = stockOffers();
    if (!so) return noStock();
    const b = balance();
    const budget = b && state.tiBudget && b.user > 0 ? b.user : 0;
    const list = stockList(budget);
    const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${l}</option>`;
    const good = list.filter((r) => r.profit > 0).length;
    const ov = list.overall;
    // meilleur contrat toutes caisses : affiche a part s'il n'a pas de caisse principale
    const ovCard = ov && !list.some((r) => Math.abs(r.profit - ov.profit) < 1e-9) ? tiCard(ov, -1, b) : "";
    const cards = list.map((r, i) => tiCard(r, i, b)).join("");
    return `<div class="panel"><div class="panel-head"><h2>Meilleurs contrats avec le stock tradeit</h2>
        <div class="btns">
          <label>Composition <select id="ti-mix">${opt(0, "100 % une caisse", state.tiMix)}${opt(1, "+ 1 Covert d'une autre caisse", state.tiMix)}${opt(2, "+ 2 Coverts d'autres caisses", state.tiMix)}</select></label>
          <label>Trier par <select id="ti-sort">${opt("profit", "Profit moyen", state.tiSort)}${opt("roi", "Rentabilité (%)", state.tiSort)}${opt("pWin", "Chance de profit", state.tiSort)}${opt("cost", "Coût le plus bas", state.tiSort)}</select></label>
          ${b ? `<label class="switch"><input type="checkbox" id="ti-budget"${state.tiBudget ? " checked" : ""}><span>Dans mon solde (${money(b.user)})</span></label>` : ""}
        </div></div>
        <p class="muted small">Pour chaque caisse, les 5 items <b>précis</b> du stock tradeit (float exact) qui maximisent le profit moyen, en mélangeant les caisses si ça rapporte plus.
          Dans une pile, tout est au même prix : on prend toujours ses plus bas floats.
          Tout est en <b>monnaie d'échange tradeit</b> : chaque Covert à son prix d'échange, chaque couteau ou paire de gants obtenus à ce que tradeit t'en donne en échange, sans frais en plus.</p>
        <p class="muted small">${stockAge()} · ${num(so.items)} items en stock (${so.hashes} skins et usures) · ${goldNote()}</p>
        <p class="small"><b>${good}</b> caisse${good > 1 ? "s" : ""} sur ${list.length} avec un contrat rentable en moyenne${state.st ? " (StatTrak™)" : ""}${budget ? ", dans ton solde" : ""}.</p></div>
      <div class="best-list">${ovCard}${cards || `<div class="panel empty">Aucun contrat possible${budget ? " dans ton solde" : ""} avec le stock actuel.</div>`}</div>`;
  }

  function tiCard(r, i, b) {
    const cls = r.profit >= 0 ? "win" : "loss";
    const est = r.outcomes.filter((o) => o.est).length;
    const items = r.inputs.map((x) => `<div class="ti-it${r.case && x.case !== r.case ? " filler" : ""}" title="${esc(x.case)}">
        ${img(x.img, x.name)}<b>${esc(x.name)}</b><small>${esc(SHORT[x.wear])} · ${x.float.toFixed(4)}</small><small>${money(x.price)}</small></div>`).join("");
    const col = r.case ? null : catalog.collections.find((c) => c.case === r.cases[0]);
    const title = r.case
      ? `${esc(r.case)}${r.fillers ? ` <span class="muted small">+ ${r.fillers} Covert${r.fillers > 1 ? "s" : ""} d'une autre caisse</span>` : ""}`
      : `Meilleur contrat toutes caisses <span class="muted small">${esc(r.cases.join(" + "))}</span>`;
    const left = b ? b.user - r.cost : null;
    return `<div class="bc ti-c">${img(r.caseImg || (col && col.img), r.case || r.cases[0])}
      <div><h3>${title}</h3><div class="ti-items">${items}</div>
        <div class="meta-row">
          <span>coût en échange <b>${money(r.cost)}</b></span>
          <span>valeur moyenne <b>${est ? "≈ " : ""}${money(r.ev)}</b></span>
          <span>rentabilité <b class="${cls}">${pct(r.roi, true)}</b></span><span>chance de profit <b>${pct(r.pWin)}</b></span>
          <span>meilleur cas <b class="win">${r.best ? signed(r.best.profit) : "—"}</b></span>
          ${left != null ? `<span>${left >= 0 ? `reste de ton solde <b>${money(left)}</b>` : `il te manque <b class="loss">${money(-left)}</b>`}</span>` : ""}
          ${est ? `<span class="muted">${est} résultat${est > 1 ? "s" : ""} estimé${est > 1 ? "s" : ""} (≈)</span>` : ""}</div>
        <div class="ti-oc" data-ocbox="${i}" hidden></div></div>
      <div class="side"><b class="${cls}">${signed(r.profit)}</b><span class="muted small">profit moyen</span>
        <button type="button" class="btn sm ghost" data-tioc="${i}">Résultats (${r.outcomes.length})</button>
        <button type="button" class="btn sm" data-tiload="${i}">Ouvrir dans le constructeur</button></div></div>`;
  }
  const tiAt = (i) => (i < 0 ? tiList.overall : tiList[i]);

  // ---------------------------------------------- Coverts en stock
  function tiStock() {
    if (!stockOffers()) return noStock();
    const opt = (v, l) => `<option value="${v}"${state.tiStockSort === v ? " selected" : ""}>${l}</option>`;
    return `<div class="panel"><div class="panel-head"><h2>Coverts en stock chez tradeit${state.st ? " (StatTrak™)" : ""}</h2>
        <div class="btns"><label>Trier par <select id="ti-ssort">${opt("price", "Prix d'échange")}${opt("float", "Plus bas float (position)")}${opt("stock", "Stock")}</select></label></div></div>
        <div class="ti-tools"><input id="ti-q" type="search" placeholder="Filtrer : AK-47, Empress, Fracture…" value="${esc(state.tiQ)}" autocomplete="off"></div>
        <p class="muted small">Prix d'échange de chaque pile. Une pile est au même prix quel que soit le float : ses plus bas floats sont les meilleurs pour un contrat. ${stockAge()}.</p>
        <p id="ti-msg" class="small win" hidden></p>
        <div id="ti-stock-table">${stockTable()}</div></div>`;
  }

  function stockTable() {
    const so = stockOffers();
    const q = (state.tiQ || "").trim().toLowerCase();
    const rows = [];
    for (const [hash, offers] of Object.entries(so.by)) {
      const c = covertOf[hash];
      if (c.st !== state.st) continue;
      const col = engine().caseOf(c.name);
      if (q && !(hash.toLowerCase().includes(q) || (col && col.case.toLowerCase().includes(q)))) continue;
      const sk = catalog.coverts[c.name];
      for (const o of offers) {
        rows.push({ hash, c, sk, col, o, pos: o.f.length ? (o.f[0] - sk.min) / (sk.max - sk.min) : Infinity });
      }
    }
    const sorters = {
      price: (a, b) => a.o.trade - b.o.trade,
      float: (a, b) => a.pos - b.pos,
      stock: (a, b) => b.o.n - a.o.n,
    };
    rows.sort(sorters[state.tiStockSort] || sorters.price);
    if (!rows.length) return `<p class="muted">Aucun Covert en stock ne correspond.</p>`;
    const shown = rows.slice(0, 200);
    const body = shown.map((r) => `<tr><td>${img(r.sk.img, r.hash)}</td>
        <td><b>${esc(r.hash.replace(/ \([^)]*\)$/, ""))}</b><br><span class="muted small">${esc(SHORT[r.c.wear])} · ${esc(r.col ? r.col.case : "")}</span></td>
        <td class="n">${num(r.o.n)}${r.o.lock ? `<br><span class="muted small">bloqué ${r.o.lock} j</span>` : ""}</td>
        <td class="n">${money(r.o.trade)}</td>
        <td class="n">${r.o.f.length ? r.o.f.slice(0, 3).map((f) => f.toFixed(4)).join("<br>") + (r.o.n > 3 ? `<br><span class="muted small">… ${r.o.hi.toFixed(4)}</span>` : "")
          : `<span class="muted small">à venir</span>`}${floatAge(r.o) ? `<br><span class="muted small">${floatAge(r.o).slice(3)}</span>` : ""}</td>
        <td><button type="button" class="btn sm ghost" data-tiadd="${esc(r.hash)}" data-tip="${r.o.trade}"${r.o.f.length
          ? ` title="Ajouter son plus bas float libre au constructeur"` : ` disabled title="Floats pas encore relevés"`}>+</button></td></tr>`).join("");
    return `<div class="scroll"><table class="ti-table"><thead><tr><th></th><th>Covert</th><th class="n">Stock</th><th class="n">Prix d'échange</th>
        <th class="n">Plus bas floats</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>${rows.length > shown.length ? `<p class="muted small">${shown.length} lignes affichées sur ${rows.length} : filtre pour affiner.</p>` : ""}`;
  }

  /** met le plus bas float libre d'une pile dans la premiere case vide du constructeur (en prix tradeit) */
  function addFromStock(hash, trade) {
    const c = covertOf[hash];
    const offer = (stockOffers().by[hash] || []).find((o) => o.trade === trade);
    if (!c || !offer) return "Item introuvable dans le stock.";
    const used = new Set(state.slots.filter((s) => s && s.ti === trade && s.name === c.name).map((s) => s.float));
    if (!offer.f.length) return "Les floats de cette pile ne sont pas encore relevés : réessaie après le prochain relevé.";
    const f = offer.f.find((x) => !used.has(x));
    if (f == null) return "Tous les floats relevés de cette pile sont déjà dans le constructeur.";
    const i = state.slots.findIndex((s) => !s);
    if (i < 0) return "Le constructeur est plein : retire un Covert d'abord.";
    state.slots[i] = { name: c.name, wear: c.wear, float: f, price: null, ti: trade };
    const was = state.pay;
    state.pay = "tradeit";
    save();
    return `${c.name} (${SHORT[c.wear]}, float ${f.toFixed(4)}) ajouté à la case ${i + 1} du constructeur${was !== "tradeit" ? ", passé en prix tradeit" : ""}.`;
  }

  // ---------------------------------------------- inventaire
  function tiInventory(file) {
    if (!file) return `<div class="panel">${SETUP}</div>`;
    if (!inv) return `<div class="panel empty">Déverrouille ton inventaire ci-dessus pour le voir.</div>`;
    const b = balance();
    const rows = inv.items.map((it) => {
      const on = !state.tiOff.includes(it.key);
      return `<tr><td><input type="checkbox" data-tioff="${esc(it.key)}" ${on ? "checked" : ""} aria-label="Échanger cet item"></td>
        <td>${img(it.img, it.name)}</td><td>${esc(it.name)}${it.qty > 1 ? ` <span class="muted">×${it.qty}</span>` : ""}</td>
        <td class="n">${money(it.user)}</td><td class="n">${money(it.user * it.qty)}</td></tr>`;
    }).join("");

    // contrat du constructeur, en prix d'echange tradeit
    const so = stockOffers();
    const filled = state.slots.filter(Boolean).map((s) => (s.ti != null ? Object.assign({}, s, { price: s.ti, src: "ti", trade: s.ti }) : s));
    const r = so ? engine("tradeit").evaluate(filled, { st: state.st }) : null;
    const toggle = `<button type="button" class="btn sm ghost" data-pay="${state.pay === "tradeit" ? "market" : "tradeit"}">${state.pay === "tradeit"
      ? "Revenir aux prix des marchés dans les autres onglets" : "Utiliser les prix tradeit dans tous les onglets"}</button>`;
    let cmp;
    if (r && r.complete && r.cost != null && r.ev != null) {
      const afford = r.cost > 0 ? Math.floor(b.user / r.cost) : 0;
      cmp = `<div class="panel"><h2>Ton contrat du constructeur, en échange</h2>
        <div class="kpis" style="margin-top:10px">
          <div class="kpi"><span>Coût en échange</span><b>${money(r.cost)}</b><small>5 Coverts au prix d'échange</small></div>
          <div class="kpi"><span>Valeur moyenne</span><b>${money(r.ev)}</b><small>ce que tradeit t'en donne</small></div>
          <div class="kpi ${r.profit >= 0 ? "win" : "loss"}"><span>Profit moyen</span><b>${signed(r.profit)}</b><small>${pct(r.roi, true)} par contrat</small></div>
          <div class="kpi best"><span>Contrats finançables</span><b>${num(afford)}</b><small>avec ton solde (${money(b.user)})</small></div>
        </div><div class="btns">${toggle}</div></div>`;
    } else {
      cmp = `<div class="panel muted">${r && r.complete && r.cost == null
        ? "Un Covert de ton contrat du constructeur n'est pas en stock chez tradeit."
        : "Compose un contrat de 5 Coverts dans le constructeur pour voir son coût en échange et combien ton solde en finance."}
        <div class="btns" style="margin-top:8px">${toggle}</div></div>`;
    }

    return `${cmp}
      <div class="panel"><div class="panel-head"><h2>Ton inventaire</h2><button type="button" class="btn sm ghost" id="ti-lock">Verrouiller</button></div>
        <p class="muted small">Coche les items que tu acceptes d'échanger : leur valeur d'échange (ce que tradeit t'accorde) forme ton solde.</p>
        <div class="scroll"><table><thead><tr><th></th><th></th><th>Item</th><th class="n">Valeur d'échange</th><th class="n">Total</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
  }

  // ========================================================== EVENEMENTS
  function loadSlots(slots) {
    state.slots = slots.slice(0, 5).concat(Array(Math.max(0, 5 - slots.length)).fill(null));
    setTab("builder");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function loadContract(groups) {
    const slots = [];
    for (const [name, wear, n] of groups) for (let i = 0; i < n; i++) slots.push({ name, wear, float: null, price: null });
    loadSlots(slots);
  }

  function bind() {
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("#st").addEventListener("change", (e) => { state.st = e.target.checked; engines.clear(); save(); render(); });
    $("#cur").addEventListener("change", (e) => { state.cur = e.target.value; save(); render(); });
    $("#mode").addEventListener("change", (e) => { state.pay = e.target.value; save(); render(); });
    $("#fee").addEventListener("change", (e) => { state.fee = Math.min(30, Math.max(0, parseFloat(e.target.value) || 0)); engines.clear(); save(); render(); });
    $("#phase").addEventListener("change", (e) => { state.phaseMode = e.target.value; engines.clear(); save(); render(); });
    $("#formula").addEventListener("change", (e) => { state.floatMode = e.target.value; engines.clear(); save(); render(); });
    $("#srcs").addEventListener("change", (e) => {
      const k = e.target.dataset.src;
      if (!k) return;
      state.off = e.target.checked ? state.off.filter((x) => x !== k) : state.off.concat(k);
      engines.clear(); save(); renderHeader(); render();
    });

    document.addEventListener("click", (e) => {
      const t = e.target;
      const rm = t.closest("[data-remove]");
      if (rm) { e.stopPropagation(); state.slots[+rm.dataset.remove] = null; save(); renderBuilder(); return; }
      const sl = t.closest("[data-slot]");
      if (sl && !t.closest(".src")) { openPicker(+sl.dataset.slot); return; }
      const go = t.closest("[data-go]");
      if (go) { setTab(go.dataset.go); return; }
      const ld = t.closest("[data-load]");
      if (ld) { loadContract(JSON.parse(ld.dataset.load)); return; }
      const pay = t.closest("[data-pay]");
      if (pay) { state.pay = pay.dataset.pay; engines.clear(); save(); render(); return; }
      const ex = t.closest("[data-ex]");
      if (ex) { state.target = ex.dataset.ex; save(); renderTarget(); return; }
      if (t.id === "ti-lock") { inv = null; mem.del("invpass"); save(); renderTradeit(); return; }

      // onglet tradeit
      const tv = t.closest("[data-tiview]");
      if (tv) { state.tiView = tv.dataset.tiview; save(); renderTradeit(); return; }
      const oc = t.closest("[data-tioc]");
      if (oc) {
        const box = $(`[data-ocbox="${oc.dataset.tioc}"]`);
        const r = tiList && tiAt(+oc.dataset.tioc);
        if (!box || !r) return;
        if (!box.innerHTML) box.innerHTML = `<div class="ocgrid">${ocCards(r.outcomes)}</div>`;
        box.hidden = !box.hidden;
        oc.textContent = box.hidden ? `Résultats (${r.outcomes.length})` : "Masquer les résultats";
        return;
      }
      const tl = t.closest("[data-tiload]");
      if (tl) {
        const r = tiList && tiAt(+tl.dataset.tiload);
        if (r) { state.pay = "tradeit"; loadSlots(r.inputs.map((x) => ({ name: x.name, wear: x.wear, float: x.float, price: null, ti: x.q.trade }))); }
        return;
      }
      const tr = t.closest("[data-tgres]");
      if (tr) {
        const box = $(`[data-tgbox="${tr.dataset.tgres}"]`);
        const r = tgAt(tr.dataset.tgres);
        if (!box || !r) return;
        if (!box.innerHTML) box.innerHTML = `<div class="ocgrid">${ocCards(r.outcomes.slice().sort((a, b) => (b.net || 0) - (a.net || 0)))}</div>`;
        box.hidden = !box.hidden;
        tr.textContent = box.hidden ? `Résultats (${r.outcomes.length})` : "Masquer les résultats";
        return;
      }
      const tg = t.closest("[data-tgload]");
      if (tg) {
        const r = tgAt(tg.dataset.tgload);
        if (r) { state.pay = "tradeit"; loadSlots(r.inputs.map((x) => ({ name: x.name, wear: x.wear, float: x.float, price: null, ti: x.q.trade }))); }
        return;
      }
      const ta = t.closest("[data-tiadd]");
      if (ta) {
        const msg = $("#ti-msg");
        msg.textContent = addFromStock(ta.dataset.tiadd, parseFloat(ta.dataset.tip));
        msg.hidden = false;
      }
    });
    document.addEventListener("keydown", (e) => {
      const sl = e.target.closest && e.target.closest(".slot.filled");
      if (sl && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPicker(+sl.dataset.slot); }
    });
    document.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "oc-sort") { state.ocSort = t.value; save(); renderBuilder(); }
      if (t.dataset && t.dataset.tioff != null) {
        const k = t.dataset.tioff;
        state.tiOff = t.checked ? state.tiOff.filter((x) => x !== k) : state.tiOff.concat(k);
        engines.clear(); save(); renderTradeit();
      }
      if (t.id === "ti-mix") { state.tiMix = +t.value; save(); renderTradeit(); }
      if (t.id === "ti-sort") { state.tiSort = t.value; save(); renderTradeit(); }
      if (t.id === "ti-budget") { state.tiBudget = t.checked; save(); renderTradeit(); }
      if (t.id === "ti-ssort") { state.tiStockSort = t.value; save(); $("#ti-stock-table").innerHTML = stockTable(); }
    });
    document.addEventListener("input", (e) => {
      if (e.target.id !== "ti-q") return;
      state.tiQ = e.target.value; save();
      $("#ti-stock-table").innerHTML = stockTable();
    });
    document.addEventListener("submit", async (e) => {
      if (e.target.id !== "ti-unlock") return;
      e.preventDefault();
      $("#ti-err").textContent = "";
      try { await unlock($("#ti-pass").value, $("#ti-remember").checked); renderTradeit(); }
      catch (err) { $("#ti-err").textContent = "Phrase secrète incorrecte (ou fichier illisible)."; }
    });

    $("#b-clear").addEventListener("click", () => { state.slots = [null, null, null, null, null]; save(); renderBuilder(); });
    $("#b-dup").addEventListener("click", () => {
      const last = state.slots.filter(Boolean).pop();
      if (!last) return;
      fillEmpty(last);
      save(); renderBuilder();
    });

    // selecteur
    $("#pk-close").addEventListener("click", closePicker);
    $("#picker").addEventListener("click", (e) => { if (e.target.id === "picker") closePicker(); });
    $("#pk-q").addEventListener("input", renderPickerList);
    $("#pk-case").addEventListener("change", renderPickerList);
    $("#pk-list").addEventListener("click", (e) => {
      const it = e.target.closest("[data-pick]");
      if (!it) return;
      pk.name = it.dataset.pick; pk.wear = null; pk.float = ""; pk.price = ""; pk.ti = null;
      $$(".pk-item", $("#pk-list")).forEach((x) => x.classList.toggle("sel", x === it));
      renderPickerDetail();
    });
    $("#pk-detail").addEventListener("click", (e) => {
      const fl = e.target.closest("[data-tif]");
      if (fl) {                                   // un item precis du stock tradeit
        pk.wear = fl.dataset.tiw; pk.float = parseFloat(fl.dataset.tif); pk.ti = parseFloat(fl.dataset.tip); pk.price = "";
        renderPickerDetail(); return;
      }
      const w = e.target.closest("[data-wear]");
      if (w) {
        const v = pickerValue();
        // le float d'un item tradeit appartient a son usure : on le lache en changeant d'usure
        const keep = v.ti == null;
        pk.wear = w.dataset.wear; pk.float = keep && v.float != null ? v.float : ""; pk.price = v.price == null ? "" : v.price; pk.ti = null;
        renderPickerDetail(); return;
      }
      if (e.target.id === "pk-put" || e.target.id === "pk-fill") {
        const v = pickerValue();
        state.slots[pk.slot] = v;
        if (e.target.id === "pk-fill") fillEmpty(v);
        save(); closePicker(); renderBuilder();
      }
    });

    // gold vise
    $("#target").addEventListener("input", (e) => {
      const hit = matchTarget(e.target.value.trim());
      if (hit && hit !== state.target) { state.target = hit; save(); renderTarget(); }
    });
    $("#target").addEventListener("focus", (e) => e.target.select());
    $("#wear").addEventListener("change", (e) => { state.minWear = e.target.value; save(); renderTarget(); });

    // meilleurs
    $("#best-sort").addEventListener("change", (e) => { state.bestSort = e.target.value; save(); renderBest(); });
    $("#best-budget").addEventListener("change", (e) => { state.bestBudget = e.target.value; save(); renderBest(); });
  }

  function fillStatic() {
    // un gold precis, ou toutes les finitions d'un couteau / de gants
    const types = [...new Set(Object.keys(catalog.golds).map(typeOf))].map((t) => t + ALL).filter((t) => targetInfo(t));
    $("#golds").innerHTML = Object.keys(catalog.golds).concat(types).sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}">`).join("");
    $("#examples").innerHTML = EXAMPLES.filter((n) => targetInfo(n)).map((n) => `<button type="button" data-ex="${esc(n)}">${esc(short(n))}</button>`).join("");
    $("#pk-case").innerHTML = `<option value="">Toutes les caisses</option>` +
      catalog.collections.slice().sort((a, b) => a.case.localeCompare(b.case)).map((c) => `<option>${esc(c.case)}</option>`).join("");
    $("#srcs").innerHTML = prices.order.map((k) =>
      `<label><input type="checkbox" data-src="${k}" ${state.off.includes(k) ? "" : "checked"}> ${esc(srcName(k))}</label>`).join("");
  }

  async function boot() {
    try {
      const [c, p, t] = await Promise.all([
        fetch("data/catalog.json").then((r) => r.json()),
        fetch("data/prices.json", { cache: "no-store" }).then((r) => r.json()),
        // stock tradeit : facultatif, le site marche sans
        fetch("data/tradeit.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      catalog = c; prices = p; stockRaw = t;
    } catch (e) {
      $("#b-result").innerHTML = `<div class="panel empty">Impossible de charger les données (${esc(e.message)}).</div>`;
      return;
    }
    for (const [name, sk] of Object.entries(catalog.coverts)) {
      for (const st of sk.st ? [false, true] : [false]) {
        for (const wear of sk.wears) covertOf[TradeupEngine.hashName(name, wear, st)] = { name, wear, st };
      }
    }
    // un contrat partage par lien (#c=nom~usure,...) remplace les cases
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("c")) {
      const slots = h.get("c").split(",").map((s) => s.split("~")).filter(([n]) => catalog.coverts[n])
        .map(([name, wear, float]) => ({ name, wear, float: float ? +float : null, price: null }));
      if (slots.length) { state.slots = slots.slice(0, 5).concat(Array(Math.max(0, 5 - slots.length)).fill(null)); state.tab = "builder"; }
    }
    if (h.get("t") && targetInfo(h.get("t"))) { state.target = h.get("t"); state.tab = "target"; }
    fillStatic();
    renderHeader();
    bind();
    setTab(state.tab);
  }

  boot();
})();
