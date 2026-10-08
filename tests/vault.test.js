// Chiffrement Python (scripts/fetch_inventory.py) -> dechiffrement JS (site/vault.js)
//   node tests/vault.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const V = require(path.join(__dirname, "..", "site", "vault.js"));

(async () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory.enc.json")));
  let ok = 0;

  const inv = await V.decrypt(file, "phrase de test");
  assert.strictEqual(inv.items.length, 3);
  assert.strictEqual(inv.items[0].name, "Special Agent Ava | FBI");
  assert.strictEqual(inv.items[0].user, 2680);
  console.log("ok  - la bonne phrase dechiffre l'inventaire"); ok++;

  await assert.rejects(() => V.decrypt(file, "mauvaise phrase"));
  console.log("ok  - une mauvaise phrase est refusee"); ok++;

  const tampered = Object.assign({}, file, { data: file.data.slice(0, -4) + (file.data.slice(-4) === "AAAA" ? "BBBB" : "AAAA") });
  await assert.rejects(() => V.decrypt(tampered, "phrase de test"));
  console.log("ok  - un fichier altere est refuse (AES-GCM authentifie)"); ok++;

  assert.ok(!JSON.stringify(file).includes("Agent Ava"), "le nom d'un item apparait en clair");
  console.log("ok  - aucun nom d'item en clair dans le fichier publie"); ok++;

  console.log(`\n${ok} tests passes`);
})().catch((e) => { console.log("ECHEC -", e.message); process.exitCode = 1; });
