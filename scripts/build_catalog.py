#!/usr/bin/env python3
"""
Construit site/data/catalog.json : pour chaque caisse qui contient des
couteaux ou des gants, la liste de ses Coverts (les inputs possibles d'un
trade-up 5 Coverts -> gold) et la liste de ses golds (les resultats possibles).

Source : ByMykel/CSGO-API, genere a partir des fichiers du jeu.

    python scripts/build_catalog.py                  # telecharge les donnees
    python scripts/build_catalog.py --local DOSSIER  # crates.json + skins.json deja telecharges
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

API = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/"
OUT = os.path.join(os.path.dirname(__file__), "..", "site", "data", "catalog.json")

WEARS = [
    ["Factory New", 0.00, 0.07],
    ["Minimal Wear", 0.07, 0.15],
    ["Field-Tested", 0.15, 0.38],
    ["Well-Worn", 0.38, 0.45],
    ["Battle-Scarred", 0.45, 1.00],
]


def load(name, local):
    if local:
        with open(os.path.join(local, name), encoding="utf-8") as f:
            return json.load(f)
    req = urllib.request.Request(API + name, headers={"User-Agent": "cs2-tradeup"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def wears_for(lo, hi):
    """Usures qui existent pour une plage de float donnee."""
    if lo is None or hi is None:
        return []          # couteau vanilla : pas d'usure
    return [w for w, a, b in WEARS if lo < b and hi > a]


def short_img(url):
    # les URLs Steam sont longues ; on garde l'image en 128px pour alleger
    return (url + "/128fx128f") if url and "steamstatic.com/economy/image/" in url else url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", help="dossier contenant crates.json et skins.json")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    crates = load("crates.json", args.local)
    skins = {s["id"]: s for s in load("skins.json", args.local)}

    coverts = {}     # nom -> infos
    golds = {}       # nom (phases fusionnees) -> infos
    collections = []

    for crate in crates:
        rares = crate.get("contains_rare") or []
        if not rares:
            continue

        inputs = []
        for item in crate.get("contains") or []:
            if item["rarity"]["name"] != "Covert":
                continue
            s = skins[item["id"]]
            lo, hi = s.get("min_float"), s.get("max_float")
            coverts[s["name"]] = {
                "min": lo, "max": hi,
                "st": bool(s.get("stattrak")),
                "wears": wears_for(lo, hi),
                "img": short_img(s.get("image")),
            }
            inputs.append(s["name"])

        # un meme gold peut apparaitre plusieurs fois (une entree par phase
        # Doppler) : on fusionne et on garde le nombre d'entrees
        pool = {}
        for item in rares:
            s = skins[item["id"]]
            name = s["name"]
            lo, hi = s.get("min_float"), s.get("max_float")
            g = golds.setdefault(name, {
                "min": lo, "max": hi,
                "st": bool(s.get("stattrak")),
                "kind": "glove" if s["category"]["name"] == "Gloves" else "knife",
                "wears": wears_for(lo, hi),
                "phases": [],
                "img": short_img(s.get("image")),
            })
            ph = s.get("phase") or item.get("phase")
            if ph and ph not in g["phases"]:
                g["phases"].append(ph)
            pool[name] = pool.get(name, 0) + 1

        if not inputs:
            continue
        collections.append({
            "case": crate["name"],
            "hash": crate.get("market_hash_name") or crate["name"],
            "type": crate.get("type") or "Terminal",
            "date": (crate.get("first_sale_date") or "").replace("/", "-"),
            "img": short_img(crate.get("image")),
            "inputs": inputs,
            # [nom du gold, nombre d'entrees dans la loot list]
            "pool": sorted(([n, k] for n, k in pool.items()), key=lambda x: x[0]),
        })

    collections.sort(key=lambda c: c["date"] or "9999")
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "github.com/ByMykel/CSGO-API",
        "wears": WEARS,
        "collections": collections,
        "coverts": coverts,
        "golds": golds,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print(f"{len(collections)} caisses, {len(coverts)} Coverts, {len(golds)} golds "
          f"-> {args.out} ({os.path.getsize(args.out) // 1024} Ko)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
