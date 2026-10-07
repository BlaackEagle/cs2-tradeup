/* Interface du simulateur. Toute la logique de calcul est dans engine.js. */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const state = {
    target: "★ Butterfly Knife | Doppler",
    minWear: "any",
    st: false,
    cur: "EUR",
    phaseMode: "merged",
    floatMode: "normalized",
    fee: 2,
    // sources desactivees : l'ancien releve Steam est exclu par defaut pour
    // que seuls des prix actuels entrent dans les calculs
    off: ["fb"],
  };
  const KEY_PRICE = 2.49;  // cle de caisse Steam, dans la devise de base des prix
  let catalog, prices;

  const SHORT = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT",
                  "Well-Worn": "WW", "Battle-Scarred": "BS" };
  const EXAMPLES = ["★ Butterfly Knife | Doppler", "★ Karambit | Doppler", "★ M9 Bayonet | Fade",
                    "★ Sport Gloves | Vice", "★ Talon Knife | Marble Fade", "★ Skeleton Knife | Fade"];

  // -------------------------------------------------------------- formats
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const base = () => prices.currency || "USD";
  const usdEur = () => (prices.fx && (prices.fx.USD_EUR || prices.fx.EUR)) || 0.86;

  /** Montant dans la devise de base des prix, affiche dans la devise choisie. */
  function money(amount, digits) {
    if (amount == null || !isFinite(amount)) return "—";
    let v = amount;
    if (state.cur !== base()) v = state.cur === "EUR" ? amount * usdEur() : amount / usdEur();
    const d = digits != null ? digits : (Math.abs(v) >= 1000 ? 0 : 2);
    return v.toLocaleString("fr-FR", { style: "currency", currency: state.cur, currencyDisplay: "narrowSymbol",
                                        minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function pct(p) {
    if (p == null) return "—";
    const v = p * 100;
    const d = v >= 10 ? 1 : v >= 1 ? 2 : v >= 0.01 ? 3 : 5;
    return v.toLocaleString("fr-FR", { maximumFractionDigits: d }) + " %";
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

  function link(src, hash) {
    const e = encodeURIComponent(hash);
    const base = encodeURIComponent(hash.replace(/ \([^)]*\)$/, ""));
    return {
      st: `https://steamcommunity.com/market/listings/730/${e}`,
      fb: `https://steamcommunity.com/market/listings/730/${e}`,
      cf: `https://csfloat.com/search?market_hash_name=${e}`,
      sk: `https://skinport.com/market?search=${base}`,
      dm: `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${e}`,
    }[src];
  }

  const srcName = (k) => (prices.sources[k] && prices.sources[k].label) || k;

  function srcBadge(q, hash) {
    if (!q) return '<span class="muted">pas en vente</span>';
    const cls = q.stale ? "src stale" : "src";
    const t = q.stale ? ` title="Prix ancien : ${esc(ago(prices.sources[q.src].updated_at))}"` : "";
    return `<a class="${cls}" href="${link(q.src, hash)}" target="_blank" rel="noopener"${t}>${esc(srcName(q.src))}</a>`;
  }

  // ------------------------------------------------------------- en-tete
  function renderSources() {
    const now = Date.now();
    const chips = prices.order.map((k) => {
      const s = prices.sources[k];
      if (!s) return "";
      const age = s.updated_at ? (now - new Date(s.updated_at)) / 3600000 : Infinity;
      let cls = "bad", txt;
      if (s.count && s.updated_at) {
        cls = age < 3 ? "ok" : age < 48 ? "warn" : "bad";
        txt = `${ago(s.updated_at)} · ${num(s.count)} prix`;
      } else {
        txt = "indisponible";
      }
      const tip = s.error ? ` title="${esc(s.error)}"` : "";
      return `<span class="chip ${cls}"${tip}><b>${esc(s.label)}</b> ${esc(txt)}</span>`;
    });
    $("#sources").innerHTML = chips.join("");

    const live = ["sk", "cf", "dm", "st"].some((k) => {
      const s = prices.sources[k];
      return s && s.count && s.updated_at && (now - new Date(s.updated_at)) < 6 * 3600000;
    });
    $("#stale").hidden = live;
    if (!live) {
      const fb = prices.sources.fb;
      $("#stale").innerHTML = `<b>Attention : aucun prix en direct pour l'instant.</b> Aucun marché n'a répondu
        ces 6 dernières heures. Pour ne pas calculer avec des prix périmés, l'ancien relevé Steam
        ${fb && fb.updated_at ? `(${esc(new Date(fb.updated_at).toLocaleDateString("fr-FR"))})` : ""} est exclu ;
        tu peux le réactiver dans les options avancées. Le relevé automatique tourne toutes les 30 minutes.`;
    }

    // devise : d'ou viennent les euros affiches
    const fx = prices.fx || {};
    const conv = prices.order.filter((k) => prices.sources[k] && prices.sources[k].native === "USD" && k !== "fb")
      .map(srcName);
    $("#fx").innerHTML = base() === "EUR"
      ? `Prix en euros. Skinport cote en € ; ${esc(conv.join(", "))} cotent en $, convertis au taux BCE
         ${fx.date ? `du ${esc(new Date(fx.date).toLocaleDateString("fr-FR"))}` : ""} : 1 $ = ${usdEur().toLocaleString("fr-FR", { maximumFractionDigits: 4 })} €${fx.stale ? " (taux ancien)" : ""}.`
      : `Prix en dollars, convertis en euros au taux de 1 $ = ${usdEur()} € quand tu choisis EUR.`;
  }

  /** Prix d'origine sur le site, quand il cote dans une autre devise que la base. */
  function nativeTip(src, price) {
    const s = prices.sources[src];
    if (!s || !s.native || s.native === base()) return "";
    const orig = base() === "EUR" ? price / usdEur() : price * usdEur();
    const txt = orig.toLocaleString("fr-FR", { style: "currency", currency: s.native, currencyDisplay: "narrowSymbol" });
    return ` title="${esc(txt)} sur ${esc(s.label)} (converti au taux BCE)"`;
  }

  // ----------------------------------------------------------- controles
  function fillControls() {
    const names = Object.keys(catalog.golds).sort((a, b) => a.localeCompare(b));
    $("#golds").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
    $("#examples").innerHTML = EXAMPLES.filter((n) => catalog.golds[n])
      .map((n) => `<button type="button" class="ex" data-t="${esc(n)}">${esc(n.replace("★ ", ""))}</button>`).join("");
    $("#srcs").innerHTML = prices.order.map((k) =>
      `<label class="check"><input type="checkbox" data-src="${k}" ${state.off.includes(k) ? "" : "checked"}> ${esc(srcName(k))}</label>`).join("");
  }

  function syncControls() {
    const g = catalog.golds[state.target];
    $("#target").value = state.target;
    const wears = g ? g.wears : [];
    $("#wear").innerHTML = `<option value="any">Peu importe</option>` +
      wears.slice(0, -1).map((w, i) => `<option value="${esc(w)}">${esc(w)}${i ? " ou mieux" : ""}</option>`).join("");
    if (![...$("#wear").options].some((o) => o.value === state.minWear)) state.minWear = "any";
    $("#wear").value = state.minWear;
    $("#wear").disabled = !wears.length;
    $("#st").disabled = !(g && g.st);
    if (!(g && g.st)) state.st = false;
    $("#st").checked = state.st;
    $("#cur").value = state.cur;
    $("#phase").value = state.phaseMode;
    $("#formula").value = state.floatMode;
    $("#fee").value = state.fee;
  }

  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("t") && catalog.golds[h.get("t")]) state.target = h.get("t");
    if (h.get("w")) state.minWear = h.get("w");
    state.st = h.get("st") === "1";
    if (h.get("cur") === "USD") state.cur = "USD";
  }

  function writeHash() {
    const h = new URLSearchParams({ t: state.target, w: state.minWear });
    if (state.st) h.set("st", "1");
    if (state.cur !== "EUR") h.set("cur", state.cur);
    history.replaceState(null, "", "#" + h.toString());
  }

  // ------------------------------------------------------------ resultats
  function run() {
    syncControls();
    writeHash();
    const g = catalog.golds[state.target];
    if (!g) {
      $("#result").innerHTML = `<div class="card empty">Choisis un couteau ou des gants dans la liste.</div>`;
      return;
    }
    const engine = TradeupEngine.create(catalog, prices, {
      fee: state.fee, phaseMode: state.phaseMode, floatMode: state.floatMode,
      sources: prices.order.filter((k) => !state.off.includes(k)),
      keyPrice: KEY_PRICE,
    });
    const t0 = performance.now();
    const res = engine.analyze(state.target, { st: state.st, minWear: state.minWear });
    const ms = Math.round(performance.now() - t0);
    $("#result").innerHTML = renderResult(res, engine) + `<p class="muted small">Calcul en ${ms} ms.</p>`;
  }

  function renderResult(res, engine) {
    const g = res.gold;
    const label = res.st ? state.target.replace("★ ", "★ StatTrak™ ") : state.target;
    const phases = g.phases.length ? `<p class="muted small">Phases possibles : ${esc(g.phases.join(", "))}. Les prix sont ceux de la phase la moins chère ; une phase rare (Ruby, Sapphire…) est un bonus non compté.</p>` : "";
    const head = `<div class="card target-card">
      ${g.img ? `<img src="${esc(g.img)}" alt="" width="128" height="96" loading="lazy" onerror="this.remove()">` : ""}
      <div><h2>${esc(label)}</h2>
        <p>${res.cases.length ? `Obtenable par trade-up depuis : <b>${esc(res.cases.join(", "))}</b>` : "Aucune caisse ne permet de l'obtenir par trade-up dans ce mode."}</p>
        ${phases}</div></div>`;

    // l'ouverture de caisses n'est pas un trade-up : hors classement, en simple comparaison
    const ranked = res.methods.filter((m) => m.kind !== "unbox");
    const unboxes = res.methods.filter((m) => m.kind === "unbox");
    if (!ranked.length) {
      // meme sans methode chiffrable, on explique pourquoi (float impossible, pas d'annonce)
      const why = res.notes.map((n) => floatNote(n, res, engine)).join("");
      return head + `<div class="card"><p class="verdict">Aucune méthode chiffrable avec les prix actuels des sites cochés :
        pas d'annonce pour l'acheter directement${why ? ", et le trade-up ne peut pas garantir cette usure" : " ni pour les inputs d'un trade-up"}.</p>${why}</div>`
        + (unboxes.length ? renderUnbox(unboxes) : "");
    }

    const best = ranked[0];
    const buy = ranked.find((m) => m.kind === "buy");
    const tu = ranked.find((m) => m.kind === "tradeup");
    let verdict = `<b>Le moins cher en moyenne : ${esc(best.label)}</b> — ${money(best.expected)}`;
    if (best.kind === "buy" && tu) {
      verdict += `. Le meilleur trade-up revient à ${money(tu.expected)} en moyenne pour avoir cette cible, soit ${(tu.expected / best.expected).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}× plus cher.`;
    } else if (best.kind === "tradeup" && buy) {
      verdict += ` en moyenne, contre ${money(buy.expected)} à l'achat direct : environ ${money(buy.expected - best.expected)} d'économie espérée, avec du risque (voir la répartition ci-dessous).`;
    }
    if (!buy) {
      verdict += `<br><span class="bad">Aucune annonce trouvée pour l'acheter directement</span> sur les sites cochés : impossible de dire si c'est moins cher que l'achat direct.`;
    }
    const notes = res.notes.map((n) => floatNote(n, res, engine)).join("");

    const rows = ranked.map((m, i) => `<tr class="${i === 0 ? "best" : ""}">
        <td>${i + 1}</td><td>${esc(m.label)}</td>
        <td class="num"><b>${money(m.expected)}</b></td>
        <td class="num">${m.kind === "buy" ? "—" : money(m.cost)}</td>
        <td class="num">${m.kind === "buy" ? "100 %" : pct(m.p)}</td>
        <td class="num">${m.kind === "buy" ? "1" : num(m.tries)}</td></tr>`).join("");

    const table = `<div class="card"><p class="verdict">${verdict}</p>${notes}
      <div class="scroll"><table class="methods">
        <thead><tr><th>#</th><th>Méthode</th><th class="num" title="Ce que coûte en moyenne l'obtention de la cible, revente des autres résultats déduite">Coût moyen pour l'avoir</th>
        <th class="num">Coût par tentative</th><th class="num">Chance par tentative</th><th class="num">Tentatives en moyenne</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="muted small">« Coût moyen pour l'avoir » = ce que tu dépenses en moyenne avant de tenir la cible, en revendant au passage tout ce qui n'est pas la cible (frais de revente ${esc(state.fee)} % déduits). Pour l'achat direct, c'est simplement le prix.</p>
      ${unboxes.length ? `<p class="muted small">Pour comparaison, sans trade-up : l'ouvrir dans une caisse coûterait ${money(unboxes[0].expected, 0)} en moyenne (${esc(unboxes[0].case)}, détail en bas de page).</p>` : ""}</div>`;

    const details = [];
    if (buy) details.push(renderBuy(buy, engine, best === buy));
    ranked.filter((m) => m.kind === "tradeup").forEach((m, i) => details.push(renderTradeup(m, i === 0)));
    if (unboxes.length) details.push(renderUnbox(unboxes));

    return head + table + details.join("");
  }

  function floatNote(n, res, engine) {
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
    return `<div class="warn-box"><b>Impossible de garantir « ${esc(res.minWear)} ou mieux » en achetant les inputs par simple palier d'usure.</b>
      Il faut une position moyenne des inputs ≤ ${n.xNeeded.toFixed(4)}, donc des floats choisis un par un (filtre de float sur CSFloat par exemple) :
      ${covs.join(" · ")}. Les autres méthodes ci-dessous ne tiennent pas compte de cette contrainte de trade-up.</div>`;
  }

  function renderBuy(m, engine, open) {
    const srcs = prices.order;
    const head = srcs.map((k) => `<th class="num">${esc(srcName(k))}</th>`).join("");
    const rows = m.rows.map((r) => {
      const cells = srcs.map((k) => {
        const q = r.all.find((x) => x.src === k);
        if (!q) return `<td class="num muted">—</td>`;
        const isBest = r.q && r.q.src === k && m.best === r;
        return `<td class="num${q.enabled ? "" : " off"}"><a href="${link(k, r.hash)}" target="_blank" rel="noopener"${nativeTip(k, q.price)}>${isBest ? "<b>" : ""}${money(q.price)}${isBest ? "</b>" : ""}</a>${q.qty != null ? `<small> ${num(q.qty)}×</small>` : ""}</td>`;
      }).join("");
      return `<tr${m.best === r ? ' class="best"' : ""}><td>${esc(r.wear || "—")}</td>${cells}</tr>`;
    }).join("");
    return `<details class="card method"${open ? " open" : ""}><summary><span>Acheter directement</span><b>${money(m.expected)}</b></summary>
      <p>Le moins cher : <b>${esc(m.best.hash)}</b> à ${money(m.best.q.price)} sur ${srcBadge(m.best.q, m.best.hash)}. Aucun risque, tu as la cible tout de suite.</p>
      <div class="scroll"><table><thead><tr><th>Usure</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">Prix = annonce la moins chère sur chaque site ; le nombre indique les annonces disponibles.
      Les prix grisés viennent d'une source décochée. Survole un prix CSFloat ou DMarket pour voir son montant d'origine en dollars.</p></details>`;
  }

  function renderTradeup(m, open) {
    const inputs = m.inputs.map((k) => `<tr>
        <td class="num"><b>${k.n}×</b></td><td>${esc(k.hash)}<br><small class="muted">${esc(k.case)}</small></td>
        <td class="num">&lt; ${k.float.toFixed(2)}</td>
        <td class="num"${nativeTip(k.q.src, k.price)}>${money(k.price)}</td><td>${srcBadge(k.q, k.hash)}</td>
        <td class="num">${money(k.price * k.n)}</td></tr>`).join("");

    const out = m.outcomes.map((o) => `<tr class="${o.isTarget ? "target" : ""}">
        <td>${esc(o.name.replace("★ ", ""))}${o.isTarget ? " <b>← cible</b>" : ""}</td>
        <td class="num">${pct(o.p)}</td><td>${esc(o.wear ? SHORT[o.wear] : "—")}</td>
        <td class="num">${o.q ? money(o.q.price) : '<span class="muted">?</span>'}</td>
        <td class="num">${o.net != null ? money(o.net) : "—"}</td></tr>`).join("");

    const profit = m.profit >= 0
      ? `<span class="good">+${money(m.profit)} par contrat en moyenne</span>`
      : `<span class="bad">${money(m.profit)} par contrat en moyenne</span>`;
    const st = m.inputs[0].hash.startsWith("StatTrak") ? " StatTrak™" : "";
    const wearTxt = m.targetWear ? `${m.targetWear} (float de sortie < ${m.targetFloatSup.toFixed(4)})` : "sans usure";

    return `<details class="card method"${open ? " open" : ""}><summary><span>${esc(m.label)}</span><b>${money(m.expected)}</b></summary>
      <div class="stats">
        <div><span>Chance d'avoir la cible</span><b>${pct(m.p)}</b><small>par contrat</small></div>
        <div><span>Prix d'un contrat</span><b>${money(m.cost)}</b><small>5 Coverts${esc(st)}</small></div>
        <div><span>Contrats en moyenne</span><b>${num(m.tries)}</b><small>${num(m.n90)} pour 90 % de chance</small></div>
        <div><span>Mise brute pour 90 %</span><b>${money(m.n90 * m.cost)}</b><small>avant revente</small></div>
        <div><span>Revente des autres golds</span><b>${money(m.othersValue)}</b><small>par contrat, en moyenne</small></div>
        <div><span>Valeur attendue du contrat</span><b>${money(m.ev)}</b><small>${profit}</small></div>
      </div>
      <h3>Comment faire</h3>
      <ol class="steps">
        <li>Achète ces 5 Coverts${esc(st)} :
          <div class="scroll"><table><thead><tr><th class="num">Qté</th><th>Skin</th><th class="num">Float max</th><th class="num">Prix</th><th>Où</th><th class="num">Total</th></tr></thead>
          <tbody>${inputs}</tbody><tfoot><tr><td></td><td colspan="4">Total du contrat</td><td class="num"><b>${money(m.cost)}</b></td></tr></tfoot></table></div>
          <small class="muted">N'importe quel float sous la limite indiquée garantit le résultat. Prix = annonce la moins chère : pour plusieurs exemplaires identiques, compte un peu plus.</small></li>
        <li>Dans CS2 : <b>Inventaire → Contrat d'échange</b>, place les 5 Coverts et signe le contrat.</li>
        <li>Tu reçois un gold tiré au hasard parmi ceux listés ci-dessous. Usure de la cible : <b>${esc(wearTxt)}</b>. Le gold reçu est bloqué 7 jours avant échange ou vente.</li>
        <li>Si ce n'est pas la cible, revends-le et recommence : il faut ${num(m.tries)} contrats en moyenne, mais ça peut être bien plus (${num(m.n90)} contrats pour être sûr à 90 %).</li>
      </ol>
      <h3>Résultats possibles (${m.outcomes.length})</h3>
      <div class="scroll"><table class="outcomes"><thead><tr><th>Gold</th><th class="num">Chance</th><th>Usure</th><th class="num">Prix</th><th class="num">Revente nette</th></tr></thead><tbody>${out}</tbody></table></div>
      ${m.unpriced ? `<p class="muted small">${m.unpriced} résultat(s) sans prix connu : comptés à 0 dans la valeur attendue.</p>` : ""}
    </details>`;
  }

  function renderUnbox(list) {
    const rows = list.map((u) => `<tr><td>${esc(u.case)}</td>
      <td class="num">${money(u.caseQuote.price)} + ${money(KEY_PRICE)}</td>
      <td class="num">${pct(u.p)}</td><td class="num">${num(u.tries)}</td>
      <td class="num"><b>${money(u.expected, 0)}</b></td></tr>`).join("");
    return `<details class="card method"><summary><span>Pour comparaison : ouvrir des caisses (pas un trade-up)</span><b>${money(list[0].expected, 0)}</b></summary>
      <div class="scroll"><table><thead><tr><th>Caisse</th><th class="num">Caisse + clé</th><th class="num">Chance par ouverture</th><th class="num">Ouvertures en moyenne</th><th class="num">Coût moyen brut</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="muted small">La 3ᵉ façon d'obtenir un gold, à côté de l'achat et du trade-up. Chance = 0,26 % d'objet rare (taux publié par Valve) × part de la cible dans le pool de la caisse${state.minWear !== "any" ? " × part de la plage de float compatible avec l'usure demandée" : ""}. Clé comptée ${money(KEY_PRICE)}. Brut : la revente des autres drops n'est pas déduite.</p></details>`;
  }

  // -------------------------------------------------------------- events
  function bind() {
    $("#target").addEventListener("input", (e) => {
      const v = e.target.value.trim();
      const hit = catalog.golds[v] ? v : Object.keys(catalog.golds).find((n) => n.toLowerCase() === v.toLowerCase());
      if (hit && hit !== state.target) { state.target = hit; run(); }
    });
    $("#target").addEventListener("focus", (e) => e.target.select());
    $("#examples").addEventListener("click", (e) => {
      const t = e.target.closest("[data-t]");
      if (t) { state.target = t.dataset.t; run(); }
    });
    $("#wear").addEventListener("change", (e) => { state.minWear = e.target.value; run(); });
    $("#st").addEventListener("change", (e) => { state.st = e.target.checked; run(); });
    $("#cur").addEventListener("change", (e) => { state.cur = e.target.value; run(); });
    $("#phase").addEventListener("change", (e) => { state.phaseMode = e.target.value; run(); });
    $("#formula").addEventListener("change", (e) => { state.floatMode = e.target.value; run(); });
    $("#fee").addEventListener("change", (e) => {
      state.fee = Math.min(30, Math.max(0, parseFloat(e.target.value) || 0)); run();
    });
    $("#srcs").addEventListener("change", (e) => {
      const k = e.target.dataset.src;
      if (!k) return;
      state.off = e.target.checked ? state.off.filter((x) => x !== k) : state.off.concat(k);
      run();
    });
  }

  async function boot() {
    try {
      const [c, p] = await Promise.all([
        fetch("data/catalog.json").then((r) => r.json()),
        fetch("data/prices.json", { cache: "no-store" }).then((r) => r.json()),
      ]);
      catalog = c; prices = p;
    } catch (e) {
      $("#result").innerHTML = `<div class="card empty">Impossible de charger les données (${esc(e.message)}).</div>`;
      return;
    }
    $("#updated").textContent = `Prix fusionnés ${ago(prices.updated_at)} · catalogue du ${new Date(catalog.generated_at).toLocaleDateString("fr-FR")}`;
    readHash();
    fillControls();
    renderSources();
    bind();
    run();
  }

  boot();
})();
