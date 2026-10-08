#!/usr/bin/env python3
"""
Inventaire de l'utilisateur, valorise par tradeit.gg, chiffre avant
publication dans site/data/inventory.enc.json.

    STEAM_ID       secret du depot : identifiant Steam 64 bits (7656...)
    INVENTORY_KEY  secret du depot : phrase secrete de chiffrement

Sans l'un des deux, rien n'est publie (et un ancien fichier est supprime).
Les logs du depot etant publics, ce script n'affiche jamais l'identifiant
ni le contenu de l'inventaire : seulement des totaux.

Donnees : tradeit lit l'inventaire Steam public (inventory/search), puis
items-prices donne pour chaque type d'item le userPrice, c'est-a-dire ce
que tradeit accorde a l'utilisateur dans un echange (centimes de dollar,
dans la monnaie d'echange de tradeit).
"""

import base64
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "data", "inventory.enc.json")
API = "https://tradeit.gg/api/v2"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"}
ITERATIONS = 250_000


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def drop(reason):
    print(reason)
    if os.path.exists(OUT):
        os.remove(OUT)
        print("ancien fichier d'inventaire supprime")
    return 0


def encrypt(payload, passphrase):
    salt, iv = os.urandom(16), os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    key = kdf.derive(passphrase.encode("utf-8"))
    data = AESGCM(key).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")       # noqa: E731
    return {"v": 1, "updated_at": payload["updated_at"], "alg": "PBKDF2-SHA256/AES-GCM-256",
            "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "data": b64(data)}


class Fail(Exception):
    pass


def safe(text):
    """Message d'erreur sans aucun nombre long (identifiant Steam, assetId...)."""
    return re.sub(r"\d{6,}", "…", re.sub(r"\s+", " ", str(text)))[:200]


def call(step, method, url, **kw):
    """Requete tradeit avec quelques essais ; l'erreur ne dit que l'etape et le code."""
    last = None
    for attempt in range(4):
        try:
            r = requests.request(method, url, headers=HEADERS, timeout=60, **kw)
        except requests.RequestException as e:
            last = f"{step} : {type(e).__name__}"
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            last = f"{step} : HTTP {r.status_code}"
            time.sleep(10 * (attempt + 1))
            continue
        if r.status_code != 200:
            raise Fail(f"{step} : HTTP {r.status_code} ({safe(r.text)})")
        try:
            return r.json()
        except ValueError:
            raise Fail(f"{step} : reponse illisible ({safe(r.text)})")
    raise Fail(last or f"{step} : echec reseau")


def fetch(steam_id):
    d = call("lecture de l'inventaire", "GET", API + "/inventory/search", params={"steamId": steam_id})
    if d.get("success") is False:
        raise Fail(f"lecture de l'inventaire : refusee ({safe(d.get('message'))})")
    inv = (d.get("data") or {}).get("inventory") or []
    groups = sorted({it["itemId"] for it in inv if it.get("itemId")})
    prices = {}
    for i in range(0, len(groups), 50):
        dd = call("valeurs d'echange", "POST", API + "/inventory/items-prices",
                  json={"context": "trade", "groupIds": groups[i:i + 50], "appId": 730})
        prices.update((dd or {}).get("data") or {})
        time.sleep(0.3)

    items = []
    for it in inv:
        p = prices.get(str(it.get("itemId"))) or {}
        site, user = p.get("sitePrice"), p.get("userPrice")
        total = it.get("totalTradePriceToday") or 0
        qty = max(1, round(total / site)) if site else 1      # la recherche donne des totaux par type
        items.append({
            "name": it.get("name"), "groupId": it.get("itemId"), "qty": qty,
            "user": user, "site": site, "store": p.get("storePrice"),
            "cash": round((it.get("totalCashPriceToday") or 0) / qty),
            "img": it.get("imgURL"),
        })
    return items


def main():
    steam_id = os.environ.get("STEAM_ID", "").strip()
    passphrase = os.environ.get("INVENTORY_KEY", "")
    if not steam_id:
        return drop("STEAM_ID non configure : inventaire non releve")
    if not passphrase:
        return drop("INVENTORY_KEY non configure : refus de publier l'inventaire en clair")
    if not re.fullmatch(r"7656\d{13}", steam_id):
        return drop("STEAM_ID invalide : 17 chiffres commencant par 7656 attendus")

    try:
        items = fetch(steam_id)
    except Fail as e:
        print(f"releve impossible : {e} -- fichier precedent conserve")
        return 0
    except Exception as e:                                   # noqa: BLE001
        print(f"releve impossible ({type(e).__name__}) -- fichier precedent conserve")
        return 0
    valued = [it for it in items if it.get("user")]
    if not valued:
        print("aucun item valorise : inventaire Steam prive, vide, ou refuse par tradeit")
        return 0

    payload = {"updated_at": now(), "currency": "USD", "unit": "cents", "items": valued}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(encrypt(payload, passphrase), f, separators=(",", ":"))
    # rien d'identifiant ni de montant : les logs du depot sont publics
    print(f"inventaire chiffre : {len(valued)} types d'items ({len(items) - len(valued)} sans prix tradeit)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
