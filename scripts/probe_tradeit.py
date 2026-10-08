#!/usr/bin/env python3
"""
Sonde temporaire n°7 : lire le stock de Coverts tradeit avec moins de requetes.
  a) une recherche peut-elle rendre les items un par un (sans piles) ?
  b) un filtre de rarete permet-il de lister tous les Coverts en quelques pages ?
  c) parametres reconnus par l'appel inventory/data dans le code du site.
Requetes espacees de 2,5 s (limite de debit de tradeit).
"""
import json
import os
import re
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


def get(params, label):
    time.sleep(2.5)
    r = S.get(API, params=dict({"gameId": 730}, **params), timeout=40)
    rl = {k: v for k, v in r.headers.items() if "rate" in k.lower() or k.lower() == "retry-after"}
    try:
        d = r.json()
    except ValueError:
        print(f"  {label}: HTTP {r.status_code} non JSON {rl}")
        return None
    items = d.get("items") or []
    single = sum(1 for x in items if x.get("assetId") is not None)
    fl = sum(1 for x in items if x.get("floatValue") is not None)
    cov = sum(1 for x in items if x.get("name") in COV)
    print(f"  {label}: HTTP {r.status_code} {len(items)} lignes, {single} unitaires, {fl} avec float, "
          f"{cov} Coverts du catalogue, cles={sorted(d)[:8]} {rl}")
    return d


print("### a) recherche sans piles ?")
base = {"offset": 0, "limit": 500, "searchValue": "AK-47 | The Empress"}
for extra in ({}, {"fresh": "true", "isForStore": 0}, {"isForStore": 1}, {"stack": "false"},
              {"groupBy": "none"}, {"stacked": "false"}, {"unstack": "true"}):
    get(dict(base, **extra), f"recherche {extra}")

print("\n### b) filtre de rarete")
for extra in ({"rarity": "Covert"}, {"rarities": "Covert"}, {"rarity[]": "Covert"}, {"type": "Covert"},
              {"quality": "Covert"}, {"filters": json.dumps({"rarity": ["Covert"]})}):
    d = get(dict({"offset": 0, "limit": 500}, **extra), f"boutique {extra}")
    if d and d.get("items"):
        names = [x.get("name") for x in d["items"][:5]]
        print(f"     premiers : {names}")

print("\n### c) code du site")
try:
    html = S.get("https://tradeit.gg/csgo/trade", headers={"Accept": "text/html"}, timeout=40).text
    js = sorted(set(re.findall(r'(?:src|href)="(/_nuxt/[^"]+\.js)"', html)))
    print(f"  {len(js)} fichiers JS")
    seen = set()
    for path in js:
        time.sleep(0.5)
        try:
            src = S.get("https://tradeit.gg" + path, timeout=40).text
        except requests.RequestException:
            continue
        for m in re.finditer(r"inventory/data", src):
            ctx = src[max(0, m.start() - 700): m.end() + 900]
            key = ctx[:120]
            if key in seen:
                continue
            seen.add(key)
            print(f"  --- {path} ---\n  {ctx}\n")
        for word in ("rarity", "exterior", "minFloat", "floatMin", "maxFloat", "isForStore", "fresh"):
            k = len(re.findall(word, src))
            if k:
                print(f"  {path}: '{word}' x{k}")
except requests.RequestException as e:
    print(f"  code illisible : {e}")
sys.exit(0)
