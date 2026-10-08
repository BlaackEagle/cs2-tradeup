#!/usr/bin/env python3
"""
Stock de Coverts de la boutique d'echange tradeit.gg, item par item, dans
site/data/tradeit.json : float exact et prix d'echange de chaque exemplaire.

La recherche par nom donne une ligne par pile (groupId), toute la pile au
meme prix. On ouvre chaque pile pour lire le float de chaque exemplaire :
le prix ne dependant pas du float, le plus bas float d'une pile ne coute pas
plus cher que le plus haut.

Par pile on garde ses KEEP floats les plus bas (un contrat prend au plus 5
items : au-dela, un exemplaire plus haut au meme prix ne sert jamais), le
nombre d'exemplaires et le float le plus haut. Prix en centimes de dollar,
dans la monnaie d'echange de tradeit.

Donnees publiques de la boutique, lues sans connexion : rien de personnel.
Si le releve echoue, le fichier precedent est garde tant qu'il a moins de
12 h, puis supprime (mieux vaut pas de stock qu'un stock perime).

    python scripts/fetch_tradeit_stock.py
"""

import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_prices import CATALOG, MAX_CARRY_H, SourceError, age_h, http, log, now  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "data", "tradeit.json")
API = os.environ.get("TRADEIT_API", "https://tradeit.gg/api/v2/inventory/data")   # faux serveur en test
HEADERS = {"Referer": "https://tradeit.gg/csgo/trade"}
KEEP = 8                    # floats gardes par pile
WORKERS = 3
PAUSE = 0.3                 # entre deux requetes d'un meme fil
BUDGET_S = 8 * 60           # au-dela, on publie ce qu'on a (releve partiel)
SAMPLES = ["AK-47 | The Empress (Field-Tested)", "M4A4 | Temukau (Field-Tested)",
           "StatTrak™ AK-47 | The Empress (Battle-Scarred)"]


def covert_names(catalog):
    names = set()
    for name, c in catalog["coverts"].items():
        for w in c["wears"]:
            names.add(f"{name} ({w})")
            if c["st"]:
                names.add(f"StatTrak™ {name} ({w})")
    return names


def get(params):
    r = http("GET", API, retries=4, params=dict({"gameId": 730}, **params), headers=HEADERS, timeout=40)
    if r.status_code != 200:
        raise SourceError(f"HTTP {r.status_code}")
    time.sleep(PAUSE)
    return r.json()


def search(base_name):
    """Lignes de la boutique pour un Covert (toutes usures, StatTrak compris)."""
    d = get({"offset": 0, "limit": 200, "searchValue": base_name})
    counts = d.get("counts") or {}
    return [(it, counts.get(str(it.get("groupId")))) for it in d.get("items") or []]


def open_group(gid):
    """Tous les exemplaires d'une pile."""
    out, offset = [], 0
    while True:
        d = get({"groupId": gid, "offset": offset, "limit": 500, "fresh": "true", "isForStore": 0})
        items = d.get("items") or []
        out.extend(items)
        if len(items) < 500:
            return out
        offset += 500


def price_of(it):
    p = it.get("priceForTrade") or it.get("price")
    return int(p) if p else None


def main():
    with open(CATALOG, encoding="utf-8") as f:
        catalog = json.load(f)
    names = covert_names(catalog)
    t0 = time.time()
    lock = threading.Lock()
    errors = []

    # 1. recherche de chaque Covert : les piles en stock
    groups, singles = {}, []          # groupId -> (nom, prix, nombre annonce) ; items deja unitaires
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = {ex.submit(search, n): n for n in sorted(catalog["coverts"])}
        for fu in as_completed(futs):
            try:
                rows = fu.result()
            except Exception as e:                          # noqa: BLE001
                errors.append(f"recherche : {e}")
                continue
            for it, count in rows:
                name, p = it.get("name"), price_of(it)
                if name not in names or not p:
                    continue
                if it.get("assetId") is not None and it.get("floatValue") is not None:
                    singles.append(it)                      # ligne = un seul exemplaire
                elif it.get("groupId") is not None:
                    groups[it["groupId"]] = (name, p, count)
    if len(errors) > len(catalog["coverts"]) // 2:
        raise SourceError(f"recherche impossible ({errors[0]})")
    log(f"[stock] {len(groups)} piles et {len(singles)} items isoles a ouvrir "
        f"({len(errors)} recherches en echec, {time.time() - t0:.0f}s)")

    # 2. ouverture des piles : float de chaque exemplaire
    found = {gid: [] for gid in groups}
    opened, late = 0, 0
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = {}
        for gid in groups:
            futs[ex.submit(lambda g: [] if time.time() - t0 > BUDGET_S else open_group(g), gid)] = gid
        for fu in as_completed(futs):
            gid = futs[fu]
            try:
                items = fu.result()
            except Exception as e:                          # noqa: BLE001
                errors.append(f"pile : {e}")
                continue
            if not items and time.time() - t0 > BUDGET_S:
                late += 1
                continue
            with lock:
                found[gid] = items
                opened += 1

    # 3. regroupement par market_hash_name puis par (prix, blocage)
    stock = {}
    seen = 0

    def add(name, f, p, lock_days):
        stock.setdefault(name, {}).setdefault((p, lock_days), []).append(f)

    for gid, items in found.items():
        name = groups[gid][0]
        for it in items:
            f, p = it.get("floatValue"), price_of(it)
            if it.get("name") not in (None, name) or f is None or not p:
                continue
            add(name, float(f), p, int(it.get("tradeLockDay") or 0))
            seen += 1
    for it in singles:
        add(it["name"], float(it["floatValue"]), price_of(it), int(it.get("tradeLockDay") or 0))
        seen += 1

    items = {}
    for name in sorted(stock):
        offers = []
        for (p, lock_days), fl in sorted(stock[name].items()):
            fl.sort()
            o = {"p": p, "n": len(fl), "f": [round(x, 10) for x in fl[:KEEP]], "hi": round(fl[-1], 10)}
            if lock_days:
                o["lock"] = lock_days
            offers.append(o)
        items[name] = offers
    if not items:
        raise SourceError("aucun item en stock lu")

    complete = opened == len(groups) and not errors
    out = {
        "updated_at": now(), "currency": "USD", "unit": "cents", "keep": KEEP,
        "complete": complete, "groups": len(groups), "opened": opened,
        "count": seen, "items": items,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    log(f"[stock] {seen} items lus dans {opened}/{len(groups)} piles, {len(items)} Coverts en stock "
        f"-> {os.path.getsize(OUT) // 1024} Ko en {time.time() - t0:.0f}s"
        + ("" if complete else f" -- PARTIEL ({late} piles hors budget, {len(errors)} erreurs)"))
    for e in errors[:3]:
        log(f"  erreur : {e}")
    for n in SAMPLES:
        for o in items.get(n, []):
            log(f"  {n:<48} {o['n']:>3} en stock a {o['p'] / 100:.2f} $ d'echange, "
                f"floats {o['f'][0]:.4f} -> {o['hi']:.4f}" + (f", bloque {o['lock']} j" if o.get("lock") else ""))
    return 0


def keep_or_drop_previous():
    """Releve en echec : on garde le fichier precedent s'il est recent."""
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        return
    age = age_h(old.get("updated_at"))
    if age <= MAX_CARRY_H:
        log(f"[stock] fichier precedent garde (releve il y a {age:.1f} h)")
    else:
        os.remove(OUT)
        log(f"[stock] fichier precedent supprime (releve il y a {age:.0f} h)")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                                  # noqa: BLE001
        log(f"[stock] ECHEC : {str(e)[:300]}")
        keep_or_drop_previous()
        sys.exit(1)
