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

  // ------------------------------------------------------- inventaire tradeit
  await p.click('.tabs [data-tab="tradeit"]');
  await p.waitForSelector("#ti-root .panel");
  if (pass) {
    check("inventaire chiffre : formulaire de deverrouillage", !!(await p.$("#ti-unlock")));
    await p.fill("#ti-pass", "mauvaise");
    await p.click('#ti-unlock button[type="submit"]');
    await p.waitForTimeout(800);
    check("mauvaise phrase refusee", /incorrecte/.test(await text(p, "#ti-err")));
    await p.fill("#ti-pass", pass);
    await p.click('#ti-unlock button[type="submit"]');
    await p.waitForSelector("#ti-root table", { timeout: 10000 });
    const rows = await p.$$eval("#ti-root tbody tr", (x) => x.length);
    check("inventaire dechiffre : 3 items", rows === 3, `${rows} lignes`);
    const before = await text(p, "#ti-root .kpi:first-child b");
    await p.click("#ti-root tbody tr:first-child input[type=checkbox]");
    await p.waitForTimeout(200);
    check("decocher un item change la valeur d'echange", before !== (await text(p, "#ti-root .kpi:first-child b")));
    check("comparaison marche / echange", /Voie marché/.test(await text(p, "#ti-root")) && /Voie échange tradeit/.test(await text(p, "#ti-root")));
    await p.screenshot({ path: path.join(out, "tradeit.png"), fullPage: true });
    await p.click('#ti-root [data-pay="tradeit"]');
    await p.click('.tabs [data-tab="builder"]');
    await p.waitForTimeout(200);
    check("inputs payes en echange tradeit", (await p.$$eval("#slots .src.ti", (x) => x.length)) === 5);
    await p.reload({ waitUntil: "networkidle" });
    await p.click('.tabs [data-tab="tradeit"]');
    await p.waitForSelector("#ti-root table", { timeout: 10000 });
    check("phrase memorisee sur l'appareil", true);
  } else {
    // sans phrase : soit l'inventaire n'est pas configure, soit il est publie chiffre
    const t = await text(p, "#ti-root");
    check("onglet tradeit : instructions ou deverrouillage", /STEAM_ID/.test(t) || !!(await p.$("#ti-unlock")), t.slice(0, 90));
  }

  // ------------------------------------------------------------------ mobile
  const m = await page({ width: 390, height: 844 });
  await m.goto(url, { waitUntil: "networkidle" });
  await m.waitForSelector("#slots .slot");
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("mobile : pas de scroll horizontal", overflow <= 0, `debordement ${overflow}px`);
  await m.screenshot({ path: path.join(out, "mobile.png"), fullPage: true });

  await browser.close();
  check("aucune erreur JavaScript", errors.length === 0, errors.slice(0, 3).join(" || "));
  for (const [ok, name, detail] of results) console.log(`${ok ? "ok   " : "ECHEC"} ${name}${detail ? "  — " + detail : ""}`);
  process.exitCode = results.every((r) => r[0]) ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
