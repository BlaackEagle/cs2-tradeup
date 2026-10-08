#!/usr/bin/env python3
"""
Sonde temporaire n°4 : valeur donnee a l'utilisateur (userPrice) et
inventaire Steam lu par tradeit a partir d'un steamId, sans connexion.
"""
import json
import sys

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json",
                  "Origin": "https://tradeit.gg", "Referer": "https://tradeit.gg/csgo/trade"})
API = "https://tradeit.gg/api/v2"


def call(label, method, path, n=2200, **kw):
    r = S.request(method, API + path, timeout=40, **kw)
    print(f"\n### {label}\n{method} {r.url}  body={json.dumps(kw.get('json'))[:200] if kw.get('json') else ''}")
    print(f"-> HTTP {r.status_code} | {r.headers.get('content-type')} | {len(r.content)} octets")
    try:
        d = r.json()
        print("   extrait :", json.dumps(d, ensure_ascii=False)[:n])
        return d
    except ValueError:
        print("   texte :", r.text[:300])
        return None


# groupIds vus dans la boutique : Empress MW, Empress FT, Agent Ava FBI
groups = [63043, 63042, 318055]
for ctx in ("trade", "store"):
    call(f"items-prices groupIds, contexte {ctx}", "POST", "/inventory/items-prices",
         json={"context": ctx, "groupIds": groups, "appId": 730})
call("items-prices groupIds sans appId", "POST", "/inventory/items-prices",
     json={"context": "trade", "groupIds": groups})

# inventaire d'un compte par steamId : un bot de tradeit vu dans la boutique
for sid in ["76561199182740223"]:
    d = call("inventory/search par steamId", "GET", "/inventory/search", params={"steamId": sid}, n=3000)
sys.exit(0)
