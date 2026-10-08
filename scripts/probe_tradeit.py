#!/usr/bin/env python3
"""
Sonde temporaire n°9 : valeur d'echange tradeit des couteaux et gants.
  a) liste complete rarity=Covert (pages jusqu'a une page vide) : Coverts de
     caisse ET couteaux / gants, avec groupId et prix d'echange ;
  b) comparaison avec le stock releve par recherche (fichier en ligne) ;
  c) items-prices sur des piles de couteaux : userPrice / sitePrice ;
  d) noms des Doppler chez tradeit (phases).
Une requete toutes les 2,3 s.
"""
import json
import os
import re
import statistics
import sys
import time

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"})
API = "https://tradeit.gg/api/v2"
HERE = os.path.dirname(os.path.abspath(__file__))
cat = json.load(open(os.path.join(HERE, "..", "site", "data", "catalog.json"), encoding="utf-8"))
COV, GOLD = set(), set()
for n, c in cat["coverts"].items():
    for w in c["wears"]:
        COV.add(f"{n} ({w})")
        COV.add(f"StatTrak™ {n} ({w})")
for n, g in cat["golds"].items():
    st = n.replace("★ ", "★ StatTrak™ ", 1)
    if not g["wears"]:
        GOLD.add(n); GOLD.add(st)
    for w in g["wears"]:
        GOLD.add(f"{n} ({w})")
        if g["st"]:
            GOLD.add(f"{st} ({w})")
PHASE = re.compile(r" (Phase \d|Ruby|Sapphire|Black Pearl|Emerald)(?= \(|$)")
last = [0.0]
n429 = [0]


def call(method, url, **kw):
    for _ in range(4):
        wait = last[0] + 2.3 - time.time()
        if wait > 0:
            time.sleep(wait)
        last[0] = time.time()
        r = S.request(method, url, timeout=40, **kw)
        if r.status_code == 429:
            n429[0] += 1
            time.sleep(20)
            continue
        return r
    return r


print("### a) rarity=Covert, toutes les pages")
t0 = time.time()
lines, ids, pages, sizes = [], set(), 0, []
for page in range(80):
    r = call("GET", API + "/inventory/data", params={"gameId": 730, "rarity": "Covert", "offset": page * 500, "limit": 500})
    items = (r.json() or {}).get("items") or []
    pages += 1
    sizes.append(len(items))
    new = 0
    for x in items:
        k = x.get("groupId") if x.get("assetId") is None else ("a", x.get("assetId"))
        if k in ids:
            continue
        ids.add(k)
        lines.append(x)
        new += 1
    if not items:
        break
print(f"  {pages} pages en {time.time() - t0:.0f}s, tailles {sizes}, {len(lines)} lignes distinctes, 429 : {n429[0]}")
if lines:
    print("  cles d'une ligne empilee :", sorted(next((x for x in lines if x.get('assetId') is None), lines[0])))
    one = next((x for x in lines if x.get("assetId") is not None), None)
    if one:
        print("  cles d'une ligne unitaire :", sorted(one))
cov = {x["name"] for x in lines if x.get("name") in COV}
gold_lines = [x for x in lines if PHASE.sub("", x.get("name") or "") in GOLD]
gold = {PHASE.sub("", x["name"]) for x in gold_lines}
print(f"  Coverts du catalogue : {len(cov)} market_hash_name ; couteaux/gants du catalogue : {len(gold)} sur {len(GOLD)} "
      f"({len(gold_lines)} lignes)")
dop = sorted({x["name"] for x in lines if "Doppler" in (x.get("name") or "")})[:12]
print("  exemples Doppler :", dop)
odd = sorted({x.get("name") for x in lines if (x.get("name") or "").startswith("★")
              and PHASE.sub("", x.get("name") or "") not in GOLD})[:15]
print("  couteaux/gants hors catalogue (exemples) :", odd)

print("\n### b) comparaison avec la recherche par nom (stock en ligne)")
try:
    live = requests.get("https://tradeup.jaouadkabouri.dev/data/tradeit.json", timeout=30).json()
    by_search = {h for h, offers in (live.get("items") or {}).items() if any(o.get("n", 0) > 0 for o in offers)}
    print(f"  recherche : {len(by_search)} hash ; liste : {len(cov)} ; communs {len(by_search & cov)} ; "
          f"seulement recherche {len(by_search - cov)} ; seulement liste {len(cov - by_search)}")
    print("  exemples seulement recherche :", sorted(by_search - cov)[:8])
except Exception as e:  # noqa: BLE001
    print("  fichier en ligne illisible :", e)

print("\n### c) items-prices sur 50 piles de couteaux/gants")
gids = [x["groupId"] for x in gold_lines if x.get("groupId") is not None][:50]
if gids:
    r = call("POST", API + "/inventory/items-prices", json={"context": "trade", "groupIds": gids, "appId": 730})
    data = (r.json() or {}).get("data") or {}
    ratios, diffs = [], []
    for x in gold_lines:
        p = data.get(str(x.get("groupId")))
        if not p:
            continue
        if p.get("sitePrice") and p.get("userPrice"):
            ratios.append(p["userPrice"] / p["sitePrice"])
        if p.get("sitePrice") and x.get("priceForTrade"):
            diffs.append(p["sitePrice"] / x["priceForTrade"])
    print(f"  HTTP {r.status_code}, {len(data)} prix ; userPrice/sitePrice : "
          + (f"min {min(ratios):.3f} med {statistics.median(ratios):.3f} max {max(ratios):.3f}" if ratios else "-")
          + " ; sitePrice/priceForTrade : "
          + (f"min {min(diffs):.3f} med {statistics.median(diffs):.3f} max {max(diffs):.3f}" if diffs else "-"))
    ex = next(iter(data.items()), None)
    print("  exemple :", ex)
print(f"\nHTTP 429 au total : {n429[0]}")
sys.exit(0)
