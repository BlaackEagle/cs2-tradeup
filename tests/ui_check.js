// Pilote le site dans Chromium :
//   node tests/ui_check.js http://127.0.0.1:8765/ dossier_captures [phrase_inventaire]
"use strict";
const path = require("path");
const { chromium } = require(path.join(require("child_process").execSync("npm root -g").toString().trim(), "playwright"));

(async () => {
  const [url, out, pass] = process.argv.slice(2);
  const browser = await chromium.launch();
  const errors = [];
  const results = [];
  const check = (name, ok, detail) => results.push([!!ok, name, detail || ""]);

  async function page(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    // seules les images du CDN Steam sont tolerees (bloquees dans l'environnement de test)
    p.on("requestfailed", (r) => {
      const host = new URL(r.url()).host;
      if (!(r.resourceType() === "image" && /steamstatic\.com|akamaihd\.net/.test(host))) errors.push(`requete en echec : ${r.resourceType()} ${r.url()}`);
    });
    return p;
  }
  const text = async (p, s) => ((await p.textContent(s)) || "").replace(/\s+/g, " ").trim();

  const p = await page({ width: 1280, height: 900 });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForSelector("#slots .slot");
  const tiModeOk = await p.$eval('#mode [value="tradeit"]', (o) => !o.disabled);
  check("prix tradeit par defaut quand le stock est releve", !tiModeOk || (await p.$eval("#mode", (e) => e.value)) === "tradeit");
  await p.selectOption("#mode", "market");             // d'abord la logique des marches
  await p.waitForTimeout(150);

  // ------------------------------------------------------------ constructeur
  check("onglet Constructeur par defaut", (await p.getAttribute('.tabs [data-tab="builder"]', "aria-selected")) === "true");
  check("5 cases vides", (await p.$$eval("#slots .slot.empty", (x) => x.length)) === 5);
  check("message d'accueil", /Ajoute des Coverts/.test(await text(p, "#b-result")));

  await p.click('#slots [data-slot="0"]');
  await p.waitForSelector("#picker[open]");
  check("selecteur ouvert", true);
  await p.fill("#pk-q", "Empress");
  await p.waitForTimeout(100);
  const listed = await p.$$eval("#pk-list .pk-item", (x) => x.map((e) => e.dataset.pick));
  check("recherche « Empress »", listed.length === 1 && listed[0] === "AK-47 | The Empress", listed.join(", "));
  await p.click('#pk-list [data-pick="AK-47 | The Empress"]');
  await p.click('#pk-detail [data-wear="Field-Tested"]');
  const ftPrice = await text(p, '#pk-detail [data-wear="Field-Tested"] small');
  await p.click("#pk-fill");
  await p.waitForTimeout(150);
  check("5 cases remplies", (await p.$$eval("#slots .slot.filled", (x) => x.length)) === 5);
  check("selecteur referme", !(await p.$("#picker[open]")));
  const kpis = await p.$$eval(".kpi", (x) => x.map((e) => e.innerText.replace(/\s+/g, " ")));
  // les titres sont en majuscules par le style : comparaison insensible a la casse
  check("synthese : cout, valeur, profit, chance, meilleur, pire", kpis.length >= 6 && /Coût du contrat/i.test(kpis[0])
        && ["Valeur moyenne", "Profit moyen", "Chance de profit", "Meilleur cas", "Pire cas"].every((k) => new RegExp(k, "i").test(kpis.join(" "))),
        kpis.slice(0, 3).join(" | "));
  const cost = parseFloat(kpis[0].match(/([\d\s ,]+)\s*€/)[1].replace(/[\s ]/g, "").replace(",", "."));
  const unit = parseFloat(ftPrice.replace(/[\s €]/g, "").replace(",", "."));
  check("cout = 5 × prix FT", Math.abs(cost - 5 * unit) < 0.02, `${cost} vs 5 × ${unit}`);
  check("30 resultats (pool Spectrum 2)", (await p.$$eval(".ocgrid .oc", (x) => x.length)) === 30);
  check("barre de probabilites", (await p.$$eval(".probbar i", (x) => x.length)) === 30);
  check("cartes gain/perte colorees", (await p.$$eval(".oc.w, .oc.l", (x) => x.length)) > 0);
  await p.screenshot({ path: path.join(out, "constructeur.png"), fullPage: true });

  // float exact + prix impose sur la case 2
  await p.click('#slots [data-slot="1"]');
  await p.waitForSelector("#picker[open]");
  await p.waitForTimeout(100);
  await p.fill("#pk-float", "0.2");
  await p.fill("#pk-price", "50");
  await p.click("#pk-put");
  await p.waitForTimeout(150);
  const s2 = await text(p, '#slots [data-slot="1"]');
  check("float exact affiche", /float 0,2000|float 0\.2000/.test(s2), s2);
  check("prix impose affiche", /50,00\s*€/.test(s2) && /ton prix/.test(s2), s2);

  // retrait d'une case
  await p.click('#slots [data-remove="4"]');
  await p.waitForTimeout(100);
  check("case retiree -> contrat incomplet", /Encore 1 Covert/.test(await text(p, "#b-result")));
  await p.click("#b-dup");
  await p.waitForTimeout(100);
  check("copier le dernier dans les cases vides", (await p.$$eval("#slots .slot.filled", (x) => x.length)) === 5);

  // StatTrak
  await p.check("#st");
  await p.waitForTimeout(200);
  check("StatTrak : inputs StatTrak", /StatTrak™ AK-47/.test(await text(p, "#slots")));
  const ocNames = await p.$$eval(".ocgrid .oc-n", (x) => x.map((e) => e.innerText));
  check("StatTrak : resultats StatTrak", ocNames.length > 0 && ocNames.every((n) => /StatTrak™/.test(n)));
  await p.uncheck("#st");

  // devise
  await p.selectOption("#cur", "USD");
  await p.waitForTimeout(100);
  check("bascule en dollars", /\$/.test(await text(p, ".kpis")));
  await p.selectOption("#cur", "EUR");

  // ------------------------------------------------------------ gold vise
  await p.click('.tabs [data-tab="target"]');
  await p.waitForSelector("#t-result .method");
  const methods = await p.$$eval("#t-result .method h3", (x) => x.map((e) => e.innerText));
  check("gold vise : methodes listees", methods.some((m) => /Trade-up/.test(m)), methods.join(" | "));
  await p.click('#t-result [data-load]');
  await p.waitForTimeout(200);
  check("gold vise -> charge dans le constructeur", (await p.getAttribute('.tabs [data-tab="builder"]', "aria-selected")) === "true"
        && (await p.$$eval("#slots .slot.filled", (x) => x.length)) === 5);

  // ------------------------------------------------------- meilleurs contrats
  await p.click('.tabs [data-tab="best"]');
  await p.waitForSelector("#best-list .bc");
  const nbc = await p.$$eval("#best-list .bc", (x) => x.length);
  check("meilleurs contrats : une carte par caisse", nbc >= 30, `${nbc} cartes`);
  const profits = await p.$$eval("#best-list .bc .side b", (x) => x.map((e) => parseFloat(e.innerText.replace(/[^\d,−-]/g, "").replace("−", "-").replace(",", "."))));
  check("tri par profit decroissant", profits.every((v, i) => i === 0 || v <= profits[i - 1] + 1e-9));
  await p.fill("#best-budget", "200");
  await p.dispatchEvent("#best-budget", "change");
  await p.waitForTimeout(200);
  const costs = await p.$$eval("#best-list .bc .meta-row span:first-child b", (x) => x.map((e) => parseFloat(e.innerText.replace(/[^\d,]/g, "").replace(",", "."))));
  check("budget max respecte", costs.length > 0 && costs.every((c) => c <= 200.001), `${costs.length} contrats ≤ 200 €`);
  await p.screenshot({ path: path.join(out, "meilleurs.png"), fullPage: false });
  await p.click("#best-list [data-load]");
  await p.waitForTimeout(200);
  check("meilleur contrat -> constructeur", (await p.$$eval("#slots .slot.filled", (x) => x.length)) === 5);

  // ---------------------------------------------------------------- tradeit
  await p.click('.tabs [data-tab="tradeit"]');
  await p.waitForSelector("#ti-root .ti-seg");
  const hasStock = !!(await p.$("#ti-root .ti-c"));
  const tiText = await text(p, "#ti-root");
  check("tradeit : contrats sur le stock, ou stock pas encore releve", hasStock || /pas encore relevé/.test(tiText), tiText.slice(0, 100));
  const money = (s) => parseFloat(s.replace(/[^\d,−-]/g, "").replace("−", "-").replace(",", "."));
  if (hasStock) {
    const cards = await p.$$eval("#ti-root .ti-c", (x) => x.map((c) => c.querySelectorAll(".ti-it").length));
    check("contrats du stock : 5 items precis chacun", cards.length >= 5 && cards.every((n) => n === 5), `${cards.length} contrats`);
    check("tout en monnaie d'echange tradeit", /monnaie d'échange tradeit/.test(tiText));
    check("aucune comparaison aux autres sites", !/Skinport|CSFloat|DMarket|au marché|tu cèdes/i.test(tiText), tiText.match(/Skinport|CSFloat|DMarket|au marché|tu cèdes/i));
    const profits = await p.$$eval("#ti-root .ti-c .side b", (x) => x.map((e) => e.innerText));
    check("contrats du stock tries par profit", profits.map(money).every((v, i, a) => i === 0 || v <= a[i - 1] + 1e-9), profits.slice(0, 3).join(" "));
    await p.click("#ti-root [data-tioc]");
    await p.waitForTimeout(100);
    check("resultats d'un contrat du stock", (await p.$$eval("#ti-root .ti-oc:not([hidden]) .oc", (x) => x.length)) > 0);
    await p.selectOption("#ti-mix", "0");
    await p.waitForTimeout(300);
    const fillers = await p.$$eval("#ti-root .ti-c .ti-it.filler", (x) => x.length);
    check("composition 100 % une caisse : aucun complement", fillers === 0, `${fillers} complements`);
    await p.selectOption("#ti-mix", "2");
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(out, "tradeit-contrats.png"), fullPage: false });
  }

  if (pass) {
    check("inventaire chiffre : formulaire de deverrouillage", !!(await p.$("#ti-unlock")));
    await p.fill("#ti-pass", "mauvaise");
    await p.click('#ti-unlock button[type="submit"]');
    await p.waitForTimeout(800);
    check("mauvaise phrase refusee", /incorrecte/.test(await text(p, "#ti-err")));
    await p.fill("#ti-pass", pass);
    await p.click('#ti-unlock button[type="submit"]');
    await p.waitForSelector("#ti-root .kpi", { timeout: 10000 });
    check("inventaire deverrouille : solde d'echange", /Ton solde d'échange/.test(await text(p, "#ti-root")));
    await p.click('#ti-root [data-tiview="inv"]');
    await p.waitForSelector("#ti-root table", { timeout: 10000 });
    const rows = await p.$$eval("#ti-root tbody tr", (x) => x.length);
    check("inventaire dechiffre : 3 items", rows === 3, `${rows} lignes`);
    const before = await text(p, "#ti-root .kpi:first-child b");
    await p.click("#ti-root tbody tr:first-child input[type=checkbox]");
    await p.waitForTimeout(200);
    check("decocher un item change la valeur d'echange", before !== (await text(p, "#ti-root .kpi:first-child b")));
    const invTxt = await text(p, "#ti-root");
    check("contrat du constructeur en echange", /Ton contrat du constructeur, en échange|pas en stock chez tradeit/.test(invTxt));
    check("inventaire sans prix des autres sites", !/Marché|Skinport|CSFloat|DMarket/.test(invTxt));
    await p.screenshot({ path: path.join(out, "tradeit.png"), fullPage: true });
    if (hasStock) {
      await p.selectOption("#mode", "tradeit");
      await p.click('.tabs [data-tab="builder"]');
      await p.waitForTimeout(200);
      check("prix tradeit dans le constructeur", (await p.$$eval("#slots .src.ti", (x) => x.length)) === 5);
      check("valeur en echange dans le constructeur", /ce que tradeit t'en donne/.test(await text(p, "#b-result")));
    }
    await p.reload({ waitUntil: "networkidle" });
    await p.click('.tabs [data-tab="tradeit"]');
    await p.waitForSelector("#ti-root table", { timeout: 10000 });
    check("phrase memorisee sur l'appareil", true);
  } else {
    // sans phrase : soit l'inventaire n'est pas configure, soit il est publie chiffre
    const t = await text(p, "#ti-root");
    check("onglet tradeit : instructions ou deverrouillage", /STEAM_ID/.test(t) || !!(await p.$("#ti-unlock")), t.slice(0, 90));
  }

  if (hasStock) {
    // un contrat du stock dans le constructeur : memes items, meme cout
    await p.click('#ti-root [data-tiview="contracts"]');
    await p.waitForSelector("#ti-root .best-list");
    if (await p.$("#ti-budget")) {
      // inventaire deverrouille : par defaut, seulement les contrats dans le solde
      const bal = money(await text(p, "#ti-root .kpi:first-child b"));
      const trades = await p.$$eval("#ti-root .ti-c .meta-row span:first-child b", (x) => x.map((e) => e.innerText));   // cout en echange
      check("dans mon solde : contrats financables", trades.map(money).every((v) => v <= bal + 0.01), `${trades.length} contrats, solde ${bal}`);
      if (await p.isChecked("#ti-budget")) { await p.uncheck("#ti-budget"); await p.waitForTimeout(300); }
    }
    await p.waitForSelector("#ti-root .ti-c");
    const cede = await text(p, "#ti-root .ti-c .meta-row span:first-child b");
    const fl = await p.$$eval("#ti-root .ti-c:first-of-type .ti-it small:first-of-type", (x) => x.map((e) => e.innerText.split("· ")[1]));
    await p.click("#ti-root .ti-c [data-tiload]");
    await p.waitForSelector("#slots .slot.filled");
    await p.waitForTimeout(200);
    check("contrat du stock -> constructeur : 5 items tradeit", (await p.$$eval("#slots .src.ti", (x) => x.length)) === 5);
    const slotsTxt = await text(p, "#slots");
    check("floats exacts du stock repris", fl.length === 5 && fl.every((f) => slotsTxt.includes(f)), fl.join(" "));
    const kc = await text(p, ".kpi:first-child b");
    check("cout du constructeur = cout en echange du contrat", Math.abs(money(kc) - money(cede)) < 0.011, `${kc} vs ${cede}`);

    // Coverts en stock : tableau, filtre, ajout au constructeur
    await p.click("#b-clear");
    await p.click('.tabs [data-tab="tradeit"]');
    await p.click('#ti-root [data-tiview="stock"]');
    await p.waitForSelector("#ti-stock-table tbody tr");
    const nrows = await p.$$eval("#ti-stock-table tbody tr", (x) => x.length);
    check("Coverts en stock : tableau", nrows > 10, `${nrows} lignes`);
    const heads = await text(p, "#ti-stock-table thead");
    check("Coverts en stock : prix d'echange, sans colonne marche", /Prix d'échange/.test(heads) && !/Marché|Écart|cèdes/.test(heads), heads);
    await p.fill("#ti-q", "Empress");
    await p.waitForTimeout(150);
    const names = await p.$$eval("#ti-stock-table tbody td:nth-child(2) b", (x) => x.map((e) => e.innerText));
    check("filtre « Empress »", names.length > 0 && names.every((n) => /Empress/.test(n)), names.slice(0, 2).join(", "));
    await p.fill("#ti-q", "");
    await p.waitForTimeout(150);
    await p.click("#ti-stock-table [data-tiadd]:not([disabled])");
    check("ajout au constructeur", /case 1/.test(await text(p, "#ti-msg")), await text(p, "#ti-msg"));
    await p.screenshot({ path: path.join(out, "tradeit-stock.png"), fullPage: false });
    await p.click('.tabs [data-tab="builder"]');
    await p.waitForTimeout(150);
    check("item du stock dans la case 1", !!(await p.$('#slots [data-slot="0"] .src.ti')));

    // selecteur : choisir un float precis du stock
    await p.click('#slots [data-slot="1"]');
    await p.waitForSelector("#picker[open]");
    await p.fill("#pk-q", "Empress");
    await p.waitForTimeout(100);
    await p.click('#pk-list [data-pick="AK-47 | The Empress"]');
    const offers = await p.$$eval("#pk-detail .pk-offer", (x) => x.length);
    check("selecteur : stock tradeit du Covert", offers > 0, `${offers} piles`);
    if (await p.$("#pk-detail .pk-offer .fl")) {
      const f = await text(p, "#pk-detail .pk-offer .fl");
      await p.click("#pk-detail .pk-offer .fl");
      check("selecteur : item tradeit choisi", (await text(p, "#pk-detail .ti-pick")).includes(f), f);
      await p.click("#pk-put");
      await p.waitForTimeout(150);
      const s = await text(p, '#slots [data-slot="1"]');
      check("case 2 : float et prix tradeit", s.includes(f) && /tradeit/.test(s), s);
    }
  }

  // ------------------------------------------------------------------ mobile
  const m = await page({ width: 390, height: 844 });
  await m.goto(url, { waitUntil: "networkidle" });
  await m.waitForSelector("#slots .slot");
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("mobile : pas de scroll horizontal", overflow <= 0, `debordement ${overflow}px`);
  await m.screenshot({ path: path.join(out, "mobile.png"), fullPage: true });
  await m.click('.tabs [data-tab="tradeit"]');
  await m.waitForSelector("#ti-root .ti-seg");
  await m.waitForTimeout(300);
  const overflowTi = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("mobile tradeit : pas de scroll horizontal", overflowTi <= 0, `debordement ${overflowTi}px`);
  await m.screenshot({ path: path.join(out, "mobile-tradeit.png"), fullPage: false });

  await browser.close();
  check("aucune erreur JavaScript", errors.length === 0, errors.slice(0, 3).join(" || "));
  for (const [ok, name, detail] of results) console.log(`${ok ? "ok   " : "ECHEC"} ${name}${detail ? "  — " + detail : ""}`);
  process.exitCode = results.every((r) => r[0]) ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
