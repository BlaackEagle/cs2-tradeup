#!/usr/bin/env python3
"""
Sonde temporaire n°2 : prix tradeit par item, configuration, agents, pagination.
Lance par .github/workflows/probe.yml, resultat dans le log du run.
"""
import json
import re
import sys

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
                  "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"})
API = "https://tradeit.gg/api/v2"


def show(label, method, path, n=1800, **kw):
    url = path if path.startswith("http") else API + path
    try:
        r = S.request(method, url, timeout=40, **kw)
    except Exception as e:                                   # noqa: BLE001
        print(f"\n### {label}\n{method} {url}\n-> {type(e).__name__}: {e}")
        return None
    print(f"\n### {label}\n{method} {r.url}\n-> HTTP {r.status_code} | {r.headers.get('content-type')} | {len(r.content)} octets")
    try:
        d = r.json()
    except ValueError:
        print("   texte :", re.sub(r"\s+", " ", r.text[:300]))
        return None
    if isinstance(d, dict):
        print("   cles :", list(d)[:30])
    elif isinstance(d, list):
        print(f"   liste[{len(d)}]")
    print("   extrait :", json.dumps(d, ensure_ascii=False)[:n])
    return d


def brief(items, k=8):
    """Champs de prix d'une liste d'items de boutique."""
    for it in (items or [])[:k]:
        print(f"   - {it.get('name')!r} float={it.get('floatValue')} price={it.get('price')} "
              f"trade={it.get('priceForTrade')} site={it.get('sitePrice')} store={it.get('storePrice')} "
              f"storeBase={it.get('storeBasePrice')} stable={it.get('stablePrice')} lock={it.get('tradeLockDay')} "
              f"group={it.get('groupId')} asset={it.get('assetId')}")


# 1. configuration publique : multiplicateurs / bonus d'echange ?
cfg = show("configurations", "GET", "/configurations/", n=4000)

# 2. prix par item : la valeur donnee a N'IMPORTE QUEL item ?
show("items-prices (GET)", "GET", "/inventory/items-prices", params={"gameId": 730}, n=2500)
names = ["AK-47 | The Empress (Field-Tested)", "Special Agent Ava | FBI",
         "Sir Bloody Miami Darryl | The Professionals"]
show("items-prices (GET, noms)", "GET", "/inventory/items-prices",
     params=[("gameId", 730)] + [("names", n) for n in names])
show("items-prices (POST, noms)", "POST", "/inventory/items-prices", json={"gameId": 730, "names": names})
show("items-prices (POST, marketHashNames)", "POST", "/inventory/items-prices",
     json={"gameId": 730, "marketHashNames": names})

# 3. taux de change, recherche, items CS2
show("exchange-rate", "GET", "/exchange-rate", n=800)
show("search", "GET", "/inventory/search", params={"gameId": 730, "searchValue": "Empress"}, n=1200)
show("csgo-items", "GET", "/inventory/csgo-items", params={"gameId": 730}, n=1200)

# 4. agents en boutique : prix d'echange vs prix boutique
d = show("boutique : agents", "GET", "/inventory/data",
         params={"gameId": 730, "offset": 0, "limit": 30, "searchValue": "Agent"}, n=300)
brief((d or {}).get("items"))
d = show("boutique : Empress (detail des prix)", "GET", "/inventory/data",
         params={"gameId": 730, "offset": 0, "limit": 30, "searchValue": "The Empress"}, n=300)
brief((d or {}).get("items"), 12)

# 5. pagination et taille du stock
d = show("boutique : limite 500", "GET", "/inventory/data",
         params={"gameId": 730, "offset": 0, "limit": 500, "sortType": "Popularity"}, n=400)
if d:
    print("   items renvoyes :", len(d.get("items", [])), "| counts :", json.dumps(d.get("counts"))[:600])
sys.exit(0)
