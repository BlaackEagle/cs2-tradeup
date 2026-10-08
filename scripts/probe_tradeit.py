#!/usr/bin/env python3
"""
Sonde temporaire n°3 : comment le site de tradeit lit l'inventaire de
l'utilisateur et valorise ses items (code autour des routes concernees).
"""
import re
import sys

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA})

html = S.get("https://tradeit.gg/csgo/trade", timeout=30).text
srcs = re.findall(r"""(?:src|href)=["']([^"']+\.js)["']""", html)
srcs += re.findall(r"""["'](/_nuxt/[A-Za-z0-9_\-]+\.js)["']""", html)
seen, bundles = set(), []
queue = list(dict.fromkeys(srcs))
# suit les imports dynamiques des chunks (_nuxt/xxx.js) jusqu'a 120 fichiers
while queue and len(bundles) < 120:
    s = queue.pop(0)
    url = s if s.startswith("http") else "https://tradeit.gg" + (s if s.startswith("/") else "/" + s)
    if url in seen:
        continue
    seen.add(url)
    try:
        js = S.get(url, timeout=30).text
    except Exception:                                        # noqa: BLE001
        continue
    bundles.append((url, js))
    for m in re.findall(r"""["'](?:\./|/_nuxt/)?([A-Za-z0-9_\-]{6,}\.js)["']""", js):
        queue.append("/_nuxt/" + m)
print(f"{len(bundles)} fichiers JS lus")

for needle in ["inventory/my/data", "items-prices", "checkTrade", "priceForTrade", "tradeValue", "userPrice"]:
    hits = 0
    for url, js in bundles:
        for m in re.finditer(re.escape(needle), js):
            if hits >= 4:
                break
            a, b = max(0, m.start() - 450), min(len(js), m.end() + 450)
            print(f"\n=== {needle} — {url.rsplit('/', 1)[-1]} @ {m.start()}")
            print(re.sub(r"\s+", " ", js[a:b]))
            hits += 1
    if not hits:
        print(f"\n=== {needle} : introuvable")
sys.exit(0)
