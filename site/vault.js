/*
 * Dechiffrement de l'inventaire publie chiffre (data/inventory.enc.json).
 * PBKDF2-SHA256 -> cle AES-GCM 256 bits, compatible avec
 * scripts/fetch_inventory.py (bibliotheque Python cryptography).
 * Fonctionne dans le navigateur et sous Node 20+ (crypto.subtle).
 */
(function (root) {
  "use strict";

  function bytes(b64) {
    if (typeof atob === "function") return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return Uint8Array.from(Buffer.from(b64, "base64"));
  }

  async function decrypt(file, pass) {
    const subtle = (root.crypto || globalThis.crypto).subtle;
    const enc = new TextEncoder();
    const k0 = await subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await subtle.deriveKey(
      { name: "PBKDF2", salt: bytes(file.salt), iterations: file.iter, hash: "SHA-256" },
      k0, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: bytes(file.iv) }, key, bytes(file.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  const api = { decrypt };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TradeupVault = api;
})(typeof self !== "undefined" ? self : this);
