#!/usr/bin/env python3
"""
Sonde temporaire : que peut-on lire sur tradeit.gg sans etre connecte ?
Lance par .github/workflows/probe.yml, resultat dans le log du run.
"""
import json
import re
import sys

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


def show(label, url, **kw):
    try:
        r = S.get(url, timeout=30, **kw)
    except Exception as e:                                   # noqa: BLE001
        print(f"\n### {label}\n{url}\n-> {type(e).__name__}: {e}")
        return None
    ct = r.headers.get("content-type", "")
    print(f"\n### {label}\n{url}\n-> HTTP {r.status_code} | {ct} | {len(r.content)} octets"
          f" | server={r.headers.get('server')} cf-ray={r.headers.get('cf-ray')}")
    if "json" in ct:
        try:
            d = r.json()
            print("   cles :", list(d)[:20] if isinstance(d, dict) else f"liste[{len(d)}]")
            print("   extrait :", json.dumps(d, ensure_ascii=False)[:1500])
        except ValueError:
            print("   json illisible :", r.text[:300])
    else:
        print("   debut :", re.sub(r"\s+", " ", r.text[:400]))
    return r


# 1. page boutique : quels scripts, quelles routes /api/ ?
page = show("page boutique", "https://tradeit.gg/csgo/store")
apis, scripts = set(), []
if page is not None and page.status_code == 200:
    html = page.text
    apis |= set(re.findall(r"""["'`](/api/[A-Za-z0-9_./\-]+)""", html))
    scripts = re.findall(r"""src=["']([^"']+\.js)["']""", html)
    print("\nscripts :", scripts[:30])
    for src in scripts[:25]:
        url = src if src.startswith("http") else "https://tradeit.gg" + (src if src.startswith("/") else "/" + src)
        try:
            js = S.get(url, timeout=30).text
        except Exception:                                    # noqa: BLE001
            continue
        apis |= set(re.findall(r"""["'`](/api/[A-Za-z0-9_./\-${}]+)""", js))
        apis |= set(re.findall(r"""["'`](https://[a-z0-9.\-]*tradeit\.gg/api/[A-Za-z0-9_./\-${}]+)""", js))
print("\nroutes /api/ trouvees :")
for a in sorted(apis):
    print("  ", a)

# 2. endpoints candidats de la boutique
base = "https://tradeit.gg/api/v2/inventory/data"
for label, params in [
    ("boutique, populaires", {"gameId": 730, "offset": 0, "limit": 20, "sortType": "Popularity", "fresh": "true"}),
    ("boutique, recherche Empress", {"gameId": 730, "offset": 0, "limit": 20, "searchValue": "The Empress"}),
    ("boutique, contexte trade", {"gameId": 730, "offset": 0, "limit": 20, "context": "trade"}),
]:
    show(label, base, params=params, headers={"Accept": "application/json", "Referer": "https://tradeit.gg/csgo/store"})

# 3. inventaire utilisateur (attendu : refuse sans connexion)
show("mon inventaire (sans connexion)", "https://tradeit.gg/api/v2/inventory/my/data?gameId=730",
     headers={"Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"})
sys.exit(0)
