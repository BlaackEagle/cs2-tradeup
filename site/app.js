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
  const EXAMPLES = ["★ Butterfly Knife | Doppler", "★ Karambit | Doppler", "★ M9 Bayonet | Fade",
                    "★ Sport Gloves | Vice", "★ Talon Knife | Marble Fade", "★ Skeleton Knife | Fade"];
  const KEY_PRICE = 2.49;            // cle de caisse Steam
  const MARKET = ["sk", "cf", "dm", "st"];

  const DEFAULTS = {
    tab: "builder", st: false, cur: "EUR", fee: 2, phaseMode: "merged", floatMode: "normalized",
    off: ["fb"],                     // l'ancien releve Steam est exclu par defaut
    slots: [null, null, null, null, null],
    pay: "market",                   // "market" | "tradeit" : comment on paie les inputs
    target: "★ Butterfly Knife | Doppler", minWear: "any",
    bestSort: "profit", bestBudget: "", ocSort: "value",
    tiOff: [],                       // items d'inventaire exclus de l'echange
  };
  const state = Object.assign({}, DEFAULTS, mem.get("state", {}));
  if (!Array.isArray(state.slots) || state.slots.length !== 5) state.slots = DEFAULTS.slots.slice();
  const save = () => mem.set("state", state);

  let catalog, prices, inv = null, invFile = null;
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
  /** valeur de marche cedee par unite de valeur d'echange tradeit */
  function tradeRate() {
    if (!inv) return null;
    let m = 0, u = 0;
    for (const it of inv.items) {
      if (state.tiOff.includes(it.key)) continue;
      m += it.market * it.qty; u += it.user * it.qty;
    }
    return u > 0 ? m / u : null;
  }

  function tradeitQuote(hash) {
    const it = prices.items[hash];
    const rate = tradeRate();
    if (!it || !it.tt || !rate) return null;
    return { price: it.tt[0] * rate, src: "ti", qty: it.tt[1], trade: it.tt[0], stale: false };
  }

  function engine(pay) {
    pay = pay || state.pay;
    if (pay === "tradeit" && !tradeRate()) pay = "market";
    const key = [pay, state.fee, state.phaseMode, state.floatMode, state.off.join(","),
                 pay === "tradeit" ? tradeRate() : ""].join("|");
    if (!engines.has(key)) {
      engines.clear();
      engines.set(key, TradeupEngine.create(catalog, prices, {
        fee: state.fee, phaseMode: state.phaseMode, floatMode: state.floatMode, keyPrice: KEY_PRICE,
        sources: prices.order.filter((k) => !state.off.includes(k)),
        inputQuote: pay === "tradeit" ? tradeitQuote : null,
      }));
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
    }).join("");

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
    $("#fee").value = state.fee;
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
    const p = row && row.q ? `${money(row.price)} ${srcBadge(row.q, row.hash)}` : '<span class="muted">prix inconnu</span>';
    const col = engine().caseOf(s.name);
    return `<div class="slot filled${state.st ? " st" : ""}" data-slot="${i}" role="button" tabindex="0">
      <button type="button" class="slot-x" data-remove="${i}" aria-label="Retirer">×</button>
      ${img(sk && sk.img, s.name)}
      <div class="slot-n">${state.st ? "StatTrak™ " : ""}${esc(s.name)}</div>
      <div class="slot-w">${esc(SHORT[wear] || wear || "")} · ${fl}</div>
      <div class="slot-p">${p}</div>
      <div class="slot-c">${esc(col ? col.case : "")}</div></div>`;
  }

  function evaluateSlots() {
    const filled = state.slots.map((s, i) => (s ? Object.assign({ __i: i }, s) : null)).filter(Boolean);
    const r = engine().evaluate(filled, { st: state.st });
    r.inputs.forEach((row, k) => { row.__i = filled[k].__i; });
    return r;
  }

  function renderBuilder() {
    const r = evaluateSlots();
    $("#slots").innerHTML = state.slots.map((s, i) => slotHtml(s, i, r)).join("");
    $("#b-result").innerHTML = builderResult(r);
  }

  function payNote() {
    if (state.pay !== "tradeit") return "";
    const rate = tradeRate();
    return rate ? `<p class="muted small">Inputs payés en échange tradeit : prix d'échange × ${rate.toLocaleString("fr-FR", { maximumFractionDigits: 3 })} (valeur marché de tes items cédée par unité d'échange).</p>` : "";
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
        <div class="kpi"><span>Coût du contrat</span><b>${money(r.cost)}</b><small>5 Coverts${state.st ? " StatTrak™" : ""}</small></div>
        <div class="kpi"><span>Valeur moyenne</span><b>${money(r.ev)}</b><small>revente nette, frais ${esc(state.fee)} %</small></div>
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
    const cards = list.map((o) => {
      const cls = o.profit == null ? "" : o.profit >= 0 ? "w" : "l";
      const fl = o.float != null ? ` · ${o.float.toFixed(4)}` : "";
      return `<div class="oc ${cls}">
        ${img(o.img, o.name)}
        <div class="oc-n">${state.st && catalog.golds[o.name].st ? "StatTrak™ " : ""}${esc(short(o.name))}</div>
        <div class="oc-w">${esc(o.wear ? SHORT[o.wear] : "sans usure")}${fl}${o.cappedBy ? ` · coté au prix ${esc(SHORT[o.cappedBy])}` : ""}</div>
        <div class="oc-r"><span class="oc-p">${pct(o.p)}</span><span class="oc-v">${o.net != null ? money(o.net) : "?"}</span></div>
        <div class="oc-g ${cls === "w" ? "win" : cls === "l" ? "loss" : "muted"}">${o.profit != null ? `${signed(o.profit)} <small>(${pct(o.roi, true)})</small>` : (o.net == null ? "sans prix actuel" : "")}</div>
      </div>`;
    }).join("");
    return errs + head + payNote() + `
      <div class="res-head"><h2>Résultats possibles (${r.outcomes.length})</h2>
        <label>Trier <select id="oc-sort">
          <option value="value"${state.ocSort === "value" ? " selected" : ""}>par valeur</option>
          <option value="chance"${state.ocSort === "chance" ? " selected" : ""}>par chance</option>
          <option value="name"${state.ocSort === "name" ? " selected" : ""}>par nom</option></select></label></div>
      <p class="muted small">${xTxt}${r.unpriced ? ` · ${r.unpriced} résultat(s) sans prix actuel, comptés 0 €` : ""}</p>
      <div class="ocgrid">${cards}</div>`;
  }

  // ----------------------------------------------------------- selecteur
  const pk = { slot: 0, name: null, wear: null, float: "", price: "" };

  function openPicker(i) {
    pk.slot = i;
    const s = state.slots[i];
    pk.name = s ? s.name : null;
    pk.wear = s ? s.wear : null;
    pk.float = s && s.float != null ? s.float : "";
    pk.price = s && s.price != null ? s.price : "";
    $("#pk-title").textContent = `Case ${i + 1} : choisir un Covert`;
    renderPickerList();
    renderPickerDetail();
    const d = $("#picker");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    setTimeout(() => $("#pk-q").focus(), 30);
  }
  function closePicker() {
    const d = $("#picker");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  /** prix d'achat d'un input selon le mode de paiement choisi */
  const priceFor = (hash) => (state.pay === "tradeit" && tradeRate() ? tradeitQuote(hash) : engine().quote(hash));

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
    box.innerHTML = `${img(sk.img, pk.name)}
      <div><b>${state.st ? "StatTrak™ " : ""}${esc(pk.name)}</b><br><span class="muted small">${esc(engine().caseOf(pk.name).case)} · float ${sk.min}–${sk.max}</span></div>
      <div><span class="muted small">Usure</span><div class="wears">${wears}</div></div>
      <label>Float exact (facultatif)
        <input id="pk-float" type="number" step="0.0001" min="${sk.min}" max="${sk.max}" placeholder="${sk.min} – ${sk.max}" value="${esc(pk.float)}" inputmode="decimal"></label>
      <label>Ton prix (facultatif)
        <input id="pk-price" type="number" step="0.01" min="0" placeholder="prix du marché" value="${esc(pk.price)}" inputmode="decimal"></label>
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
    return { name: pk.name, wear: pk.wear, float: f, price };
  }

  // ========================================================== GOLD VISE
  function renderTarget() {
    const g = catalog.golds[state.target];
    $("#target").value = state.target;
    const wears = g ? g.wears : [];
    $("#wear").innerHTML = `<option value="any">Peu importe</option>` +
      wears.slice(0, -1).map((w, i) => `<option value="${esc(w)}">${esc(w)}${i ? " ou mieux" : ""}</option>`).join("");
    if (![...$("#wear").options].some((o) => o.value === state.minWear)) state.minWear = "any";
    $("#wear").value = state.minWear;
    $("#wear").disabled = !wears.length;
    if (!g) { $("#t-result").innerHTML = `<div class="panel empty">Choisis un couteau ou des gants.</div>`; return; }

    const st = state.st && g.st;
    const res = engine().analyze(state.target, { st, minWear: state.minWear });
    const label = st ? state.target.replace("★ ", "★ StatTrak™ ") : state.target;
    const phases = g.phases.length ? `<p class="muted small">Phases : ${esc(g.phases.join(", "))}. Prix de la phase la moins chère ; une phase rare est un bonus non compté.</p>` : "";
    const hero = `<div class="panel hero">${img(g.img, label)}<div><h2>${esc(label)}</h2>
      <p>${res.cases.length ? `Par trade-up depuis : <b>${esc(res.cases.join(", "))}</b>` : "Aucune caisse ne le donne par trade-up dans ce mode."}</p>${phases}
      ${state.st && !g.st ? '<p class="warn-box" style="margin:8px 0 0">Pas de version StatTrak™ (gants) : calcul en version normale.</p>' : ""}</div></div>`;

    const ranked = res.methods.filter((m) => m.kind !== "unbox");
    const unbox = res.methods.filter((m) => m.kind === "unbox");
    const notes = res.notes.map((n) => floatNote(n, res)).join("");
    if (!ranked.length) {
      $("#t-result").innerHTML = hero + notes + `<div class="panel empty">Aucune méthode chiffrable avec les prix actuels des sites cochés.</div>`;
      return;
    }
    const best = ranked[0];
    const cards = ranked.map((m) => {
      const isBest = m === best;
      if (m.kind === "buy") {
        return `<div class="method${isBest ? " best" : ""}"><div>
          <h3>Acheter directement${isBest ? " · le moins cher" : ""}</h3>
          <div class="meta-row"><span>${esc(m.best.hash)}</span><span>${srcBadge(m.best.q, m.best.hash)}</span><span>aucun risque</span></div></div>
          <div class="big">${money(m.expected)}<small>prix actuel</small></div></div>`;
      }
      const thumbs = m.inputs.map((k) => `<div class="thumb">${img(catalog.coverts[k.name].img, k.name)}${k.n}× ${esc(SHORT[k.wear])}</div>`).join("");
      return `<div class="method${isBest ? " best" : ""}"><div>
          <h3>${esc(m.label)}${isBest ? " · le moins cher en moyenne" : ""}</h3>
          <div class="thumbs">${thumbs}</div>
          <div class="meta-row"><span>contrat <b>${money(m.cost)}</b></span><span>chance <b>${pct(m.p)}</b></span>
            <span><b>${num(m.tries)}</b> contrats en moyenne</span><span>valeur moyenne <b>${money(m.ev)}</b></span>
            <span>cible ${esc(m.targetWear || "")}</span></div>
          <div class="btns" style="margin-top:8px"><button type="button" class="btn sm" data-load='${esc(JSON.stringify(m.inputs.map((k) => [k.name, k.wear, k.n])))}'>Ouvrir dans le constructeur</button></div>
        </div><div class="big">${money(m.expected)}<small>coût moyen pour l'avoir</small></div></div>`;
    }).join("");
    const buy = ranked.find((m) => m.kind === "buy");
    const tu = ranked.find((m) => m.kind === "tradeup");
    let verdict = "";
    if (best.kind === "buy" && tu) verdict = `L'achat direct est <b>${(tu.expected / best.expected).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}× moins cher</b> que le meilleur trade-up pour avoir cette cible précise.`;
    else if (best.kind === "tradeup" && buy) verdict = `Le trade-up revient en moyenne <b>${money(buy.expected - best.expected)} moins cher</b> que l'achat direct, avec du risque.`;
    else if (!buy) verdict = `<span class="loss">Aucune annonce actuelle pour l'acheter directement</span> : impossible de comparer avec l'achat.`;
    const unboxLine = unbox.length ? `<p class="muted small">Pour comparaison, l'ouvrir dans une caisse coûterait ${money(unbox[0].expected, 0)} en moyenne (${esc(unbox[0].case)}, ${pct(unbox[0].p)} par ouverture, clé ${money(KEY_PRICE)}).</p>` : "";
    $("#t-result").innerHTML = hero + notes + `<div class="panel"><p style="margin:0 0 10px">${verdict}</p><div class="methods">${cards}</div>
      <p class="muted small">« Coût moyen pour l'avoir » = ce que tu dépenses en moyenne avant de tenir la cible, en revendant au passage les autres résultats (frais ${esc(state.fee)} %).</p>${unboxLine}</div>`;
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
    $("#best-list").innerHTML = `<p class="muted small">${good} caisse${good > 1 ? "s" : ""} sur ${list.length} avec un contrat rentable en moyenne${state.st ? " (StatTrak™)" : ""}${state.pay === "tradeit" && tradeRate() ? ", inputs payés en échange tradeit" : ""}.</p>${cards}`;
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

  /** inventaire dechiffre -> lignes valorisees dans la devise des prix */
  function prepareInventory(raw) {
    const items = raw.items.map((it) => {
      const key = it.name;
      const user = usdToBase((it.user || 0) / 100);          // ce que tradeit t'accorde, par unite
      const ours = engine("market").quote(it.name);
      const cash = usdToBase((it.cash || 0) / 100);
      return { key, name: it.name, qty: it.qty || 1, img: it.img, user,
               market: ours ? ours.price : cash, marketSrc: ours ? srcName(ours.src) : "estimation tradeit" };
    }).filter((it) => it.user > 0);
    items.sort((a, b) => b.user * b.qty - a.user * a.qty);
    return { updated_at: raw.updated_at, items };
  }

  async function unlock(pass, remember) {
    const file = await loadInventoryFile();
    const raw = await TradeupVault.decrypt(file, pass);
    inv = prepareInventory(raw);
    if (remember) mem.set("invpass", pass); else mem.del("invpass");
    engines.clear();
  }

  async function renderTradeit() {
    const root = $("#ti-root");
    const file = await loadInventoryFile();
    if (!file) {
      root.innerHTML = `<div class="panel"><h2>Ton inventaire tradeit n'est pas encore relevé</h2>
        <p>Le relevé automatique lit ton inventaire via tradeit avec ton identifiant Steam (inventaire Steam public, aucune connexion),
        récupère la valeur exacte que tradeit t'accorde pour chaque item, puis <b>chiffre</b> le tout avec une phrase secrète
        avant de le publier. Seul ton navigateur peut le déchiffrer.</p>
        <ol class="steps">
          <li>Dépôt GitHub → <b>Settings → Secrets and variables → Actions</b> → <i>New repository secret</i> :
            nom <code>STEAM_ID</code>, valeur = ton identifiant Steam 64 bits (17 chiffres, commence par 7656…).
            En secret, il reste masqué dans les logs publics du dépôt.</li>
          <li>Deuxième secret : nom <code>INVENTORY_KEY</code>, valeur = une phrase secrète de ton choix (elle chiffre l'inventaire).</li>
          <li>Attends le prochain relevé (30 min max), puis reviens ici et entre la phrase secrète.</li>
        </ol></div>`;
      return;
    }
    if (!inv) {
      const saved = mem.get("invpass", null);
      if (saved) {
        try { await unlock(saved, true); return renderTradeit(); } catch (e) { mem.del("invpass"); }
      }
      root.innerHTML = `<div class="panel"><h2>Inventaire tradeit chiffré</h2>
        <p class="muted small">Relevé ${esc(ago(file.updated_at))}. Entre ta phrase secrète (secret <code>INVENTORY_KEY</code>) : le déchiffrement se fait dans ton navigateur.</p>
        <form id="ti-unlock" class="ti-form">
          <label>Phrase secrète <input id="ti-pass" type="password" autocomplete="current-password" required></label>
          <label class="switch" style="flex:0 0 auto"><input type="checkbox" id="ti-remember" checked><span>Se souvenir sur cet appareil</span></label>
          <button class="btn" type="submit">Déverrouiller</button>
        </form><p id="ti-err" class="loss small"></p></div>`;
      return;
    }

    const rate = tradeRate();
    const sel = inv.items.filter((it) => !state.tiOff.includes(it.key));
    const totUser = sel.reduce((s, it) => s + it.user * it.qty, 0);
    const totMarket = sel.reduce((s, it) => s + it.market * it.qty, 0);
    const rows = inv.items.map((it) => {
      const on = !state.tiOff.includes(it.key);
      const ratio = it.market > 0 ? it.user / it.market : null;
      return `<tr><td><input type="checkbox" data-tioff="${esc(it.key)}" ${on ? "checked" : ""} aria-label="Échanger cet item"></td>
        <td>${img(it.img, it.name)}</td><td>${esc(it.name)}${it.qty > 1 ? ` <span class="muted">×${it.qty}</span>` : ""}</td>
        <td class="n">${money(it.user * it.qty)}</td><td class="n">${money(it.market * it.qty)}<br><span class="muted small">${esc(it.marketSrc)}</span></td>
        <td class="n ${ratio != null && ratio >= 1.7 ? "win" : ""}">${ratio != null ? "×" + ratio.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : "—"}</td></tr>`;
    }).join("");

    // contrat du constructeur : marche vs echange
    const mk = engine("market").evaluate(state.slots.filter(Boolean), { st: state.st });
    const tiEval = rate ? engine("tradeit").evaluate(state.slots.filter(Boolean), { st: state.st }) : null;
    let cmp = "";
    if (mk.complete && mk.cost != null) {
      const tradeUnits = tiEval && tiEval.cost != null ? tiEval.inputs.reduce((s, r) => s + (r.q && r.q.trade != null ? r.q.trade : NaN), 0) : null;
      const okTi = tiEval && tiEval.cost != null && isFinite(tradeUnits);
      const afford = okTi ? Math.floor(totUser / tradeUnits) : 0;
      const sellFee = state.fee / 100;
      const viaMarket = mk.cost / (1 - sellFee);
      const better = okTi && tiEval.cost < viaMarket;
      cmp = `<div class="panel"><h2>Ton contrat du constructeur : marché ou échange ?</h2>
        <div class="cmp" style="margin-top:10px">
          <div class="kpi${!better ? " best" : ""}"><span>Voie marché</span><b>${money(viaMarket)}</b>
            <small>vendre tes items (${esc(state.fee)} % de frais) pour acheter les inputs ${money(mk.cost)}</small></div>
          <div class="kpi${better ? " best" : ""}"><span>Voie échange tradeit</span><b>${okTi ? money(tiEval.cost) : "—"}</b>
            <small>${okTi ? `valeur marché de tes items cédée · ${money(tradeUnits)} en monnaie d'échange` : "un input n'est pas en stock chez tradeit"}</small></div>
          <div class="kpi"><span>Contrats finançables</span><b>${okTi ? num(afford) : "—"}</b><small>avec les items cochés (${money(totUser)} d'échange)</small></div>
        </div>
        ${okTi ? `<p>${better ? `<b class="win">L'échange est plus avantageux</b> de ${money(viaMarket - tiEval.cost)} par contrat.` : `<b class="loss">Le marché reste plus avantageux</b> de ${money(tiEval.cost - viaMarket)} par contrat.`}</p>` : ""}
        <div class="btns"><button type="button" class="btn sm ghost" data-pay="${state.pay === "tradeit" ? "market" : "tradeit"}">${state.pay === "tradeit" ? "Revenir aux prix du marché" : "Payer les inputs en échange tradeit dans tous les onglets"}</button></div></div>`;
    } else {
      cmp = `<div class="panel muted">Compose un contrat de 5 Coverts dans le constructeur pour comparer la voie marché et la voie échange.
        <div class="btns" style="margin-top:8px"><button type="button" class="btn sm ghost" data-pay="${state.pay === "tradeit" ? "market" : "tradeit"}">${state.pay === "tradeit" ? "Revenir aux prix du marché" : "Payer les inputs en échange tradeit dans tous les onglets"}</button></div></div>`;
    }

    root.innerHTML = `<div class="kpis">
        <div class="kpi best"><span>Valeur d'échange tradeit</span><b>${money(totUser)}</b><small>ce que tradeit t'accorde (items cochés)</small></div>
        <div class="kpi"><span>Valeur marché</span><b>${money(totMarket)}</b><small>mêmes items au prix du marché</small></div>
        <div class="kpi"><span>Taux</span><b>${rate ? rate.toLocaleString("fr-FR", { maximumFractionDigits: 3 }) : "—"}</b><small>€ de marché cédés par € d'échange</small></div>
        <div class="kpi"><span>Relevé</span><b>${esc(ago(inv.updated_at))}</b><small>${inv.items.length} types d'items</small></div>
      </div>${cmp}
      <div class="panel"><div class="panel-head"><h2>Ton inventaire</h2><button type="button" class="btn sm ghost" id="ti-lock">Verrouiller</button></div>
        <p class="muted small">Coche les items que tu acceptes d'échanger. Le rapport « échange / marché » montre ce que tradeit t'accorde par rapport au prix du marché, dans sa monnaie d'échange gonflée (≈ ×1,8) : compare les items entre eux, pas à 1.</p>
        <div class="scroll"><table><thead><tr><th></th><th></th><th>Item</th><th class="n">Échange tradeit</th><th class="n">Marché</th><th class="n">Échange / marché</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
  }

  // ========================================================== EVENEMENTS
  function loadContract(groups) {
    const slots = [];
    for (const [name, wear, n] of groups) for (let i = 0; i < n; i++) slots.push({ name, wear, float: null, price: null });
    state.slots = slots.slice(0, 5).concat(Array(Math.max(0, 5 - slots.length)).fill(null));
    setTab("builder");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bind() {
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("#st").addEventListener("change", (e) => { state.st = e.target.checked; engines.clear(); save(); render(); });
    $("#cur").addEventListener("change", (e) => { state.cur = e.target.value; save(); render(); });
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
      if (t.id === "ti-lock") { inv = null; mem.del("invpass"); if (state.pay === "tradeit") state.pay = "market"; engines.clear(); save(); renderTradeit(); }
    });
    document.addEventListener("keydown", (e) => {
      const sl = e.target.closest && e.target.closest(".slot.filled");
      if (sl && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPicker(+sl.dataset.slot); }
    });
    document.addEventListener("change", (e) => {
      if (e.target.id === "oc-sort") { state.ocSort = e.target.value; save(); renderBuilder(); }
      if (e.target.dataset && e.target.dataset.tioff != null) {
        const k = e.target.dataset.tioff;
        state.tiOff = e.target.checked ? state.tiOff.filter((x) => x !== k) : state.tiOff.concat(k);
        engines.clear(); save(); renderTradeit();
      }
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
      state.slots = state.slots.map((s) => s || Object.assign({}, last));
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
      pk.name = it.dataset.pick; pk.wear = null; pk.float = ""; pk.price = "";
      $$(".pk-item", $("#pk-list")).forEach((x) => x.classList.toggle("sel", x === it));
      renderPickerDetail();
    });
    $("#pk-detail").addEventListener("click", (e) => {
      const w = e.target.closest("[data-wear]");
      if (w) {
        const v = pickerValue();
        pk.wear = w.dataset.wear; pk.float = v.float == null ? "" : v.float; pk.price = v.price == null ? "" : v.price;
        renderPickerDetail(); return;
      }
      if (e.target.id === "pk-put" || e.target.id === "pk-fill") {
        const v = pickerValue();
        state.slots[pk.slot] = v;
        if (e.target.id === "pk-fill") state.slots = state.slots.map((s) => s || Object.assign({}, v));
        save(); closePicker(); renderBuilder();
      }
    });

    // gold vise
    $("#target").addEventListener("input", (e) => {
      const v = e.target.value.trim();
      const hit = catalog.golds[v] ? v : Object.keys(catalog.golds).find((n) => n.toLowerCase() === v.toLowerCase());
      if (hit && hit !== state.target) { state.target = hit; save(); renderTarget(); }
    });
    $("#target").addEventListener("focus", (e) => e.target.select());
    $("#wear").addEventListener("change", (e) => { state.minWear = e.target.value; save(); renderTarget(); });

    // meilleurs
    $("#best-sort").addEventListener("change", (e) => { state.bestSort = e.target.value; save(); renderBest(); });
    $("#best-budget").addEventListener("change", (e) => { state.bestBudget = e.target.value; save(); renderBest(); });
  }

  function fillStatic() {
    $("#golds").innerHTML = Object.keys(catalog.golds).sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}">`).join("");
    $("#examples").innerHTML = EXAMPLES.filter((n) => catalog.golds[n]).map((n) => `<button type="button" data-ex="${esc(n)}">${esc(short(n))}</button>`).join("");
    $("#pk-case").innerHTML = `<option value="">Toutes les caisses</option>` +
      catalog.collections.slice().sort((a, b) => a.case.localeCompare(b.case)).map((c) => `<option>${esc(c.case)}</option>`).join("");
    $("#srcs").innerHTML = prices.order.map((k) =>
      `<label><input type="checkbox" data-src="${k}" ${state.off.includes(k) ? "" : "checked"}> ${esc(srcName(k))}</label>`).join("");
  }

  async function boot() {
    try {
      const [c, p] = await Promise.all([
        fetch("data/catalog.json").then((r) => r.json()),
        fetch("data/prices.json", { cache: "no-store" }).then((r) => r.json()),
      ]);
      catalog = c; prices = p;
    } catch (e) {
      $("#b-result").innerHTML = `<div class="panel empty">Impossible de charger les données (${esc(e.message)}).</div>`;
      return;
    }
    // un contrat partage par lien (#c=nom~usure,...) remplace les cases
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("c")) {
      const slots = h.get("c").split(",").map((s) => s.split("~")).filter(([n]) => catalog.coverts[n])
        .map(([name, wear, float]) => ({ name, wear, float: float ? +float : null, price: null }));
      if (slots.length) { state.slots = slots.slice(0, 5).concat(Array(Math.max(0, 5 - slots.length)).fill(null)); state.tab = "builder"; }
    }
    if (h.get("t") && catalog.golds[h.get("t")]) { state.target = h.get("t"); state.tab = "target"; }
    fillStatic();
    renderHeader();
    bind();
    setTab(state.tab);
  }

  boot();
})();
