#!/usr/bin/env python3
"""
Sonde temporaire n°8 : lister tous les Coverts de la boutique tradeit par le
filtre rarity=Covert, page par page.
  a) pagination (offset de 500 en 500 : recouvrement, trous, fin de liste)
  b) Coverts du catalogue trouves, piles et items unitaires
  c) filtres de type d'arme (pour ecarter couteaux et gants)
Une requete toutes les 2,2 s ; les HTTP 429 sont comptes.
"""
import json
import os
import sys
import time

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"})
API = "https://tradeit.gg/api/v2/inventory/data"
HERE = os.path.dirname(os.path.abspath(__file__))
cat = json.load(open(os.path.join(HERE, "..", "site", "data", "catalog.json"), encoding="utf-8"))
COV = set()
for n, c in cat["coverts"].items():
    for w in c["wears"]:
        COV.add(f"{n} ({w})")
        COV.add(f"StatTrak™ {n} ({w})")
n429 = 0


def get(params):
    global n429
    for _ in range(4):
        time.sleep(2.2)
        r = S.get(API, params=dict({"gameId": 730}, **params), timeout=40)
        if r.status_code == 429:
            n429 += 1
            time.sleep(20)
            continue
        return r.json()
    return {}


print("### a/b) rarity=Covert, pages de 500")
t0 = time.time()
seen, pages, cov_lines, cov_groups, singles = {}, 0, 0, set(), 0
knife = glove = other = 0
prev_last = None
for page in range(40):
    d = get({"rarity": "Covert", "offset": page * 500, "limit": 500})
    items = d.get("items") or []
    pages += 1
    ids = [x.get("groupId") if x.get("assetId") is None else ("a", x.get("assetId")) for x in items]
    dup = sum(1 for i in ids if i in seen)
    for i, x in zip(ids, items):
        seen.setdefault(i, page)
        nm = x.get("name") or ""
        if nm in COV:
            cov_lines += 1
            cov_groups.add(i)
            singles += x.get("assetId") is not None
        elif nm.startswith("★") and ("Gloves" in nm or "Wraps" in nm):
            glove += 1
        elif nm.startswith("★"):
            knife += 1
        else:
            other += 1
    prices = [x.get("priceForTrade") or x.get("price") or 0 for x in items]
    print(f"  page {page}: {len(items)} lignes, {dup} deja vues, prix {max(prices) if prices else '-'} -> "
          f"{min(prices) if prices else '-'}, premier {items[0].get('name') if items else '-'}")
    if len(items) < 400:
        break
print(f"  total : {pages} pages en {time.time() - t0:.0f}s, {len(seen)} lignes distinctes, "
      f"{len(cov_groups)} lignes de Coverts du catalogue ({singles} unitaires), "
      f"couteaux {knife}, gants {glove}, autres Coverts {other}, HTTP 429 : {n429}")

print("\n### c) filtres de type")
for extra in ({"type": "Rifle"}, {"type": "rifle"}, {"type": "Pistol"}, {"category": "Rifle"},
              {"weapon": "AK-47"}, {"types": "Rifle"}, {"exterior": "Factory New"}):
    d = get(dict({"rarity": "Covert", "offset": 0, "limit": 500}, **extra))
    items = d.get("items") or []
    cov = sum(1 for x in items if x.get("name") in COV)
    kn = sum(1 for x in items if (x.get("name") or "").startswith("★"))
    print(f"  {extra}: {len(items)} lignes, {cov} Coverts du catalogue, {kn} couteaux/gants, "
          f"exemples {[x.get('name') for x in items[:3]]}")
print(f"\nHTTP 429 au total : {n429}")
sys.exit(0)
