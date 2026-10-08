#!/usr/bin/env python3
"""
Stock de Coverts de la boutique d'echange tradeit.gg, item par item, dans
site/data/tradeit.json : prix d'echange, nombre d'exemplaires et float exact
de chaque exemplaire.

tradeit limite le debit (environ 30 requetes par minute) : une requete
toutes les PACE secondes, et un releve incremental dans un budget de temps.
 1. Recherche par Covert (toutes usures, StatTrak compris) : les piles en
    stock (groupId), leur prix d'echange et leur nombre d'exemplaires. Les
    Coverts les moins recemment cherches d'abord ; les autres gardent leur
    releve precedent (12 h au plus).
 2. Ouverture des piles : le float de chaque exemplaire. D'abord les piles
    jamais ouvertes, puis celles dont le stock a change, puis les plus
    anciennes. Les autres gardent leurs floats precedents, avec leur date.
Toute une pile est au meme prix : son plus bas float ne coute pas plus cher.
On garde par pile ses KEEP plus bas floats (un contrat en prend au plus 5).

Donnees publiques de la boutique, lues sans connexion : rien de personnel.
Si le releve echoue entierement, le fichier precedent est garde tant qu'il
a moins de 12 h, puis supprime.

    python scripts/fetch_tradeit_stock.py
"""

import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_prices import CATALOG, MAX_CARRY_H, UA, SourceError, age_h, log, now  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "data", "tradeit.json")
API = os.environ.get("TRADEIT_API", "https://tradeit.gg/api/v2/inventory/data")   # faux serveur en test
HEADERS = {"User-Agent": UA, "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"}
KEEP = 8                                                     # floats gardes par pile
PACE = float(os.environ.get("TRADEIT_PACE", 2.3))            # secondes entre deux requetes
BUDGET_S = float(os.environ.get("TRADEIT_BUDGET", 8 * 60))   # duree max du releve
SEARCH_SHARE = 0.5           # part du budget au plus pour les recherches quand un releve precedent existe
SAMPLES = ["AK-47 | The Empress (Field-Tested)", "M4A4 | Temukau (Field-Tested)"]


class RateLimited(Exception):
    pass


class Api:
    """Requetes espacees de PACE secondes ; 429 : pause croissante, puis abandon."""

    def __init__(self):
        self.last = 0.0
        self.calls = self.n429 = self.streak = 0

    def get(self, params):
        err = None
        for attempt in range(3):
            wait = self.last + PACE - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = requests.get(API, params=dict({"gameId": 730}, **params), headers=HEADERS, timeout=40)
            except requests.RequestException as e:
                err = type(e).__name__
                time.sleep(5)
                continue
            self.calls += 1
            if r.status_code == 429 or r.status_code >= 500:
                err = f"HTTP {r.status_code}"
                if r.status_code == 429:
                    self.n429 += 1
                    self.streak += 1
                    if self.streak >= 3:
                        raise RateLimited(f"{self.streak} refus HTTP 429 de suite")
                time.sleep(20 * (attempt + 1))
                continue
            self.streak = 0
            if r.status_code != 200:
                raise SourceError(f"HTTP {r.status_code}")
            try:
                return r.json()
            except ValueError:
                raise SourceError("reponse illisible")
        raise SourceError(err or "echec reseau")


def covert_names(catalog):
    names = {}
    for name, c in catalog["coverts"].items():
        for w in c["wears"]:
            names[f"{name} ({w})"] = name
            if c["st"]:
                names[f"StatTrak™ {name} ({w})"] = name
    return names


def price_of(it):
    p = it.get("priceForTrade") or it.get("price")
    return int(p) if p else None


def load_previous():
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        return None
    if old.get("v") != 2 or age_h(old.get("updated_at")) > MAX_CARRY_H:
        return None
    return old


def main():
    with open(CATALOG, encoding="utf-8") as f:
        catalog = json.load(f)
    names = covert_names(catalog)                   # market_hash_name -> Covert
    t0 = time.time()
    api = Api()
    prev = load_previous()
    stamp = now()

    # offres precedentes, par Covert : elles restent tant que le Covert n'est pas recherche
    prev_offers, searched = {}, {}
    if prev:
        for hash_name, offers in (prev.get("items") or {}).items():
            if hash_name in names:
                prev_offers.setdefault(names[hash_name], {})[hash_name] = offers
        searched = {k: v for k, v in (prev.get("searched") or {}).items() if age_h(v) <= MAX_CARRY_H}
    prev_by_group = {o["g"]: o for by in prev_offers.values() for offers in by.values()
                     for o in offers if o.get("g") is not None}

    # 1. recherches : Coverts jamais cherches ou les plus anciens d'abord
    order = sorted(catalog["coverts"], key=lambda n: (n in searched, searched.get(n, "")))
    search_budget = BUDGET_S * (SEARCH_SHARE if prev else 0.75)
    found, stopped, errors = {}, None, []          # Covert -> {hash: [lignes]}
    for base in order:
        if time.time() - t0 > search_budget and base in searched:
            break
        try:
            d = api.get({"offset": 0, "limit": 200, "searchValue": base})
        except RateLimited as e:
            stopped = str(e)
            break
        except SourceError as e:
            errors.append(f"recherche : {e}")
            continue
        counts = d.get("counts") or {}
        rows = {}
        for it in d.get("items") or []:
            h, p = it.get("name"), price_of(it)
            if names.get(h) != base or not p:
                continue
            rows.setdefault(h, []).append((it, counts.get(str(it.get("groupId")))))
        found[base] = rows
        searched[base] = stamp
    log(f"[stock] {len(found)} Coverts cherches sur {len(catalog['coverts'])} en {time.time() - t0:.0f}s"
        + (f" -- arret : {stopped}" if stopped else ""))

    # offres a jour : celles des Coverts cherches, sinon les precedentes
    offers = {}                                    # hash -> [offre]
    for base in catalog["coverts"]:
        if base in found:
            for h, rows in found[base].items():
                for it, count in rows:
                    p = price_of(it)
                    lock = int(it.get("tradeLockDay") or 0)
                    if it.get("assetId") is not None and it.get("floatValue") is not None:
                        # exemplaire seul : son float arrive avec la recherche
                        same = next((o for o in offers.get(h, []) if o.get("g") is None and o["p"] == p), None)
                        f = round(float(it["floatValue"]), 10)
                        if same:
                            same["n"] += 1
                            same["fn"] += 1
                            same["f"] = sorted(same["f"] + [f])[:KEEP]
                            same["hi"] = max(same["hi"], f)
                        else:
                            offers.setdefault(h, []).append({"g": None, "p": p, "n": 1, "f": [f], "hi": f,
                                                             "at": stamp, "fn": 1, "lock": lock})
                        continue
                    gid = it.get("groupId")
                    if gid is None:
                        continue
                    old = prev_by_group.get(gid) or {}
                    o = {"g": gid, "p": p, "n": int(count or old.get("n") or 1), "f": old.get("f") or [],
                         "hi": old.get("hi"), "at": old.get("at"), "fn": old.get("fn"), "lock": old.get("lock", lock)}
                    if o["at"] and age_h(o["at"]) > MAX_CARRY_H:
                        o.update(f=[], hi=None, at=None, fn=None)
                    offers.setdefault(h, []).append(o)
        elif base in searched:
            for h, olds in prev_offers.get(base, {}).items():
                offers[h] = [dict(o) for o in olds]

    # 2. ouverture des piles, les plus utiles d'abord
    groups = [o for os_ in offers.values() for o in os_ if o.get("g") is not None]

    def priority(o):
        if not o.get("f"):
            return (0, "")                         # jamais ouverte (ou floats trop vieux)
        if o.get("fn") != o["n"]:
            return (1, o.get("at") or "")          # stock change depuis l'ouverture
        return (2, o.get("at") or "")              # la plus ancienne d'abord
    groups.sort(key=priority)
    opened = 0
    for o in groups:
        if stopped or time.time() - t0 > BUDGET_S:
            break
        try:
            d = api.get({"groupId": o["g"], "offset": 0, "limit": 500, "fresh": "true", "isForStore": 0})
        except RateLimited as e:
            stopped = str(e)
            break
        except SourceError as e:
            errors.append(f"pile : {e}")
            continue
        items = [it for it in d.get("items") or [] if it.get("floatValue") is not None]
        fl = sorted(float(it["floatValue"]) for it in items)
        opened += 1
        if not fl:                                 # pile vendue entre-temps
            o["n"] = 0
            continue
        o.update(f=[round(x, 10) for x in fl[:KEEP]], hi=round(fl[-1], 10), at=stamp, fn=len(fl), n=len(fl),
                 lock=max(int(it.get("tradeLockDay") or 0) for it in items))
        p = price_of(items[0])
        if p:
            o["p"] = p

    items = {}
    for h in sorted(offers):
        keep = sorted((o for o in offers[h] if o["n"] > 0), key=lambda o: o["p"])
        for o in keep:
            if not o.get("lock"):
                o.pop("lock", None)
        if keep:
            items[h] = keep
    if not items:
        raise SourceError(stopped or (errors[0] if errors else "aucun Covert en stock lu"))

    all_groups = [o for os_ in items.values() for o in os_]
    with_floats = sum(1 for o in all_groups if o["f"])
    stats = {
        "coverts": len(catalog["coverts"]), "searched": len(found), "offers": len(all_groups),
        "with_floats": with_floats, "opened": opened, "items": sum(o["n"] for o in all_groups),
        "requests": api.calls, "http429": api.n429, "errors": len(errors),
        "complete": with_floats == len(all_groups) and len(found) == len(catalog["coverts"]),
    }
    out = {"v": 2, "updated_at": stamp, "currency": "USD", "unit": "cents", "keep": KEEP,
           "searched": searched, "stats": stats, "items": items}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    log(f"[stock] {opened} piles ouvertes ; floats connus pour {with_floats}/{len(all_groups)} piles, "
        f"{stats['items']} items en stock, {len(items)} skins et usures -> {os.path.getsize(OUT) // 1024} Ko "
        f"en {time.time() - t0:.0f}s ({api.calls} requetes, {api.n429} HTTP 429, {len(errors)} erreurs)")
    for e in errors[:3]:
        log(f"  erreur : {e}")
    for n in SAMPLES:
        for o in items.get(n, []):
            fl = f"floats {o['f'][0]:.4f} -> {o['hi']:.4f}" if o["f"] else "floats pas encore lus"
            log(f"  {n:<40} {o['n']:>3} en stock a {o['p'] / 100:.2f} $ d'echange, {fl}")
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
