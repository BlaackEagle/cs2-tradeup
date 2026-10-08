#!/usr/bin/env python3
"""
Sonde temporaire n°5 : le navigateur peut-il appeler tradeit depuis notre
site (CORS) ? Et structure complete d'un item de inventory/search.
"""
import json
import sys

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
API = "https://tradeit.gg/api/v2"
ORIGIN = "https://tradeup.jaouadkabouri.dev"
CORS = ("access-control-allow-origin", "access-control-allow-methods",
        "access-control-allow-headers", "access-control-allow-credentials", "vary")


def cors(label, r):
    h = {k: r.headers.get(k) for k in CORS if r.headers.get(k) is not None}
    print(f"\n### {label}\n{r.request.method} {r.url}\n-> HTTP {r.status_code} | CORS : {h or 'aucun en-tete CORS'}")


# GET simple (pas de preflight) depuis notre origine
r = requests.get(API + "/inventory/search", params={"steamId": "76561199182740223"},
                 headers={"User-Agent": UA, "Origin": ORIGIN, "Accept": "application/json"}, timeout=40)
cors("GET inventory/search depuis notre site", r)
d = r.json().get("data", {})
print("   cles de data :", list(d)[:20])
inv = d.get("inventory") or []
print(f"   {len(inv)} items ; cles d'un item :", list(inv[0]) if inv else None)
if inv:
    print("   item complet :", json.dumps(inv[0], ensure_ascii=False)[:900])
    qty = [k for k in inv[0] if "amount" in k.lower() or "count" in k.lower() or "quant" in k.lower()]
    print("   champs de quantite :", qty)
    for k, v in d.items():
        if k != "inventory":
            print(f"   data.{k} =", json.dumps(v, ensure_ascii=False)[:300])

# POST json -> preflight OPTIONS d'abord
pre = requests.options(API + "/inventory/items-prices", headers={
    "User-Agent": UA, "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type"}, timeout=40)
cors("OPTIONS (preflight) items-prices depuis notre site", pre)
r = requests.post(API + "/inventory/items-prices", json={"context": "trade", "groupIds": [35140, 318055], "appId": 730},
                  headers={"User-Agent": UA, "Origin": ORIGIN, "Accept": "application/json"}, timeout=40)
cors("POST items-prices depuis notre site", r)
print("   reponse :", r.text[:300])

# GET boutique depuis notre origine
r = requests.get(API + "/inventory/data", params={"gameId": 730, "limit": 5, "searchValue": "The Empress"},
                 headers={"User-Agent": UA, "Origin": ORIGIN, "Accept": "application/json"}, timeout=40)
cors("GET inventory/data depuis notre site", r)
sys.exit(0)
