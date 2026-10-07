// Pilote le site dans Chromium : node tests/ui_check.js http://127.0.0.1:8765/ dossier_captures
"use strict";
const path = require("path");
const { chromium } = require(path.join(require("child_process").execSync("npm root -g").toString().trim(), "playwright"));

(async () => {
  const url = process.argv[2];
  const out = process.argv[3];
  const browser = await chromium.launch();
  const errors = [];
  const results = [];
  const check = (name, ok, detail) => { results.push([ok, name, detail || ""]); };

  async function page(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    // les echecs de chargement sont juges par requestfailed ci-dessous
    p.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text());
    });
    // seules les images du CDN Steam sont tolerees (bloquees dans l'environnement de test)
    p.on("requestfailed", (r) => {
      const host = new URL(r.url()).host;
      if (!(r.resourceType() === "image" && host.endsWith("steamstatic.com"))) {
        errors.push(`requete en echec : ${r.resourceType()} ${r.url()}`);
      }
    });
    return p;
  }

  // ----------------------------------------------------------------- bureau
  const p = await page({ width: 1280, height: 900 });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForSelector("table.methods", { timeout: 15000 });
  const verdict = await p.textContent(".verdict");
  check("verdict affiche", /moins cher/i.test(verdict), verdict.trim().slice(0, 160));
  const methods = await p.$$eval("table.methods tbody tr", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  check("au moins un trade-up liste", methods.some((m) => /Trade-up/.test(m)), methods.join(" | ").slice(0, 300));
  check("hash de l'URL renseigne", (await p.evaluate(() => location.hash)).includes("Butterfly"));
  // le bandeau "prix anciens" doit apparaitre si et seulement si aucune source live n'est fraiche
  const liveFresh = await p.evaluate(async () => {
    const d = await (await fetch("data/prices.json", { cache: "no-store" })).json();
    return ["sk", "cf", "dm", "st"].some((k) => {
      const s = d.sources[k];
      return s && s.count && s.updated_at && Date.now() - new Date(s.updated_at) < 6 * 3600000;
    });
  });
  check("bandeau 'prix anciens' coherent avec la fraicheur des sources", (await p.isVisible("#stale")) === !liveFresh,
        liveFresh ? "sources live fraiches" : "aucune source live fraiche");
  check("euros par defaut", (await p.textContent("table.methods")).includes("€"));
  check("ouverture de caisses hors du classement", !methods.some((m) => /Ouvrir/.test(m)));
  check("ligne de comparaison caisses", /Pour comparaison, sans trade-up/.test(await p.textContent("#result")));
  check("taux de change affiche", /taux BCE/.test(await p.textContent("#fx")), (await p.textContent("#fx")).trim().slice(0, 160));
  await p.screenshot({ path: path.join(out, "bureau-bfk-doppler.png"), fullPage: true });

  // usure minimale FN
  await p.selectOption("#wear", "Factory New");
  await p.waitForTimeout(150);
  const fnTxt = await p.textContent("#result");
  check("mode FN : float de sortie < 0.07", /Factory New \(float de sortie < 0\.0[0-6]\d\d\)|Factory New \(float de sortie < 0\.0700\)/.test(fnTxt));

  // StatTrak
  await p.check("#st");
  await p.waitForTimeout(150);
  const stTxt = await p.textContent("#result");
  check("mode StatTrak : inputs StatTrak", /StatTrak™ (AK-47|P250|USP-S)/.test(stTxt));
  await p.uncheck("#st");

  // devise
  await p.selectOption("#cur", "USD");
  await p.waitForTimeout(150);
  check("bascule en dollars", (await p.textContent("table.methods")).includes("$"));
  await p.selectOption("#cur", "EUR");

  // phase Doppler
  const before = await p.$eval("table.methods tbody tr:nth-child(1) td:nth-child(3)", (e) => e.innerText);
  await p.selectOption("#wear", "any");
  await p.click(".adv summary");
  await p.selectOption("#phase", "entries");
  await p.waitForTimeout(150);
  const tuChance = await p.$$eval("table.methods tbody tr", (rs) => rs.map((r) => r.innerText).find((t) => /Trade-up/.test(t)) || "");
  check("mode phases : chance ~11,7 % pour un BFK Doppler 100 % Spectrum", /11,6|11,7/.test(tuChance), tuChance.replace(/\s+/g, " "));
  await p.selectOption("#phase", "merged");
  void before;

  // gants : pas de StatTrak, gants FN impossibles par palier
  await p.fill("#target", "★ Sport Gloves | Vice");
  await p.dispatchEvent("#target", "input");
  await p.waitForTimeout(200);
  check("gants : case StatTrak desactivee", await p.isDisabled("#st"));
  await p.selectOption("#wear", "Factory New");
  await p.waitForTimeout(200);
  const glove = await p.textContent("#result");
  check("gants FN : note de float explicative", /Impossible de garantir/.test(glove));
  await p.screenshot({ path: path.join(out, "bureau-gants-fn.png"), fullPage: false });

  // exemple cliquable
  await p.click('.ex[data-t="★ Karambit | Doppler"]');
  await p.waitForTimeout(200);
  check("bouton exemple -> Karambit Doppler", (await p.textContent(".target-card h2")).includes("Karambit | Doppler"));
  await p.selectOption("#wear", "any");
  await p.waitForTimeout(150);
  const tip = await p.evaluate(() => {
    const a = document.querySelector('[title*="sur CSFloat"]');
    return a ? a.getAttribute("title") : null;
  });
  check("prix CSFloat : montant d'origine en $ au survol", !!tip && /\$/.test(tip), tip || "aucun");
  check("ancien releve exclu par defaut", !(await p.isChecked('#srcs input[data-src="fb"]')));

  // toutes les sources live decochees -> pas de calcul avec de vieux prix
  const liveBoxes = await p.$$eval('#srcs input[data-src]', (xs) => xs.filter((x) => x.checked).map((x) => x.dataset.src));
  for (const k of liveBoxes) await p.click(`#srcs input[data-src="${k}"]`);
  await p.waitForTimeout(200);
  check("sans source live -> message clair, aucun calcul", /Aucune méthode chiffrable/.test(await p.textContent("#result")));
  for (const k of liveBoxes) await p.click(`#srcs input[data-src="${k}"]`);

  // ----------------------------------------------------------------- mobile
  const m = await page({ width: 390, height: 844 });
  await m.goto(url + "#t=" + encodeURIComponent("★ Butterfly Knife | Doppler"), { waitUntil: "networkidle" });
  await m.waitForSelector("table.methods");
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("mobile : pas de scroll horizontal de page", overflow <= 0, `debordement ${overflow}px`);
  await m.screenshot({ path: path.join(out, "mobile-bfk-doppler.png"), fullPage: true });

  // ------------------------------------------------------------------ sombre
  const d = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  const dp = await d.newPage();
  dp.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await dp.goto(url, { waitUntil: "networkidle" });
  await dp.waitForSelector("table.methods");
  await dp.screenshot({ path: path.join(out, "bureau-sombre.png"), fullPage: false });

  await browser.close();
  check("aucune erreur JavaScript", errors.length === 0, errors.join(" || "));
  for (const [ok, name, detail] of results) console.log(`${ok ? "ok   " : "ECHEC"} ${name}${detail ? "  — " + detail : ""}`);
  process.exitCode = results.every((r) => r[0]) ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
