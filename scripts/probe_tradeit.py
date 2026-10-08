#!/usr/bin/env python3
"""
Sonde temporaire n°6 : contenu d'un groupe empile de la boutique tradeit
(floats et prix item par item), pour quelques Coverts.
"""
import json
import statistics
import sys
import time

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"})
API = "https://tradeit.gg/api/v2/inventory/data"

for name in ["AK-47 | The Empress", "P250 | See Ya Later", "M4A4 | Temukau"]:
    d = S.get(API, params={"gameId": 730, "offset": 0, "limit": 200, "searchValue": name}, timeout=40).json()
    counts = d.get("counts") or {}
    print(f"\n######## {name} : {len(d.get('items', []))} lignes")
    for it in d.get("items", []):
        gid = it.get("groupId")
        stack = it.get("assetId") is None
        print(f"  {it.get('name')!r} groupId={gid} stock={counts.get(str(gid))} empile={stack} "
              f"float={it.get('floatValue')} trade={it.get('priceForTrade')} cles={sorted(it)[:6]}")
    # ouvre les deux premiers groupes empiles
    for it in [x for x in d.get("items", []) if x.get("assetId") is None][:2]:
        gid = it["groupId"]
        for params in ({"gameId": 730, "groupId": gid, "offset": 0, "limit": 500, "fresh": "true", "isForStore": 0},
                       {"gameId": 730, "groupId": gid, "offset": 0, "limit": 500}):
            r = S.get(API, params=params, timeout=40)
            try:
                g = r.json()
            except ValueError:
                print(f"    groupe {gid} {params.get('isForStore')} -> HTTP {r.status_code} non JSON")
                continue
            items = g.get("items") or []
            fl = [x.get("floatValue") for x in items if x.get("floatValue") is not None]
            pr = [x.get("priceForTrade") for x in items if x.get("priceForTrade")]
            print(f"    groupe {gid} params={sorted(params)} -> HTTP {r.status_code}, {len(items)} items, "
                  f"{len(fl)} floats {('min %.5f max %.5f' % (min(fl), max(fl))) if fl else ''}, "
                  f"prix {('min %s max %s distincts %d' % (min(pr), max(pr), len(set(pr)))) if pr else ''}")
            if items:
                print("      exemple :", json.dumps({k: items[0].get(k) for k in
                      ("name", "assetId", "floatValue", "price", "priceForTrade", "storePrice", "tradeLockDay", "stackAmount")}, ensure_ascii=False))
                # le prix depend-il du float ?
                pairs = sorted((x["floatValue"], x["priceForTrade"]) for x in items if x.get("floatValue") is not None and x.get("priceForTrade"))
                if len(pairs) > 3:
                    print("      3 plus bas floats :", pairs[:3], "| 3 plus hauts :", pairs[-3:])
            time.sleep(0.4)
            if items:
                break
sys.exit(0)
