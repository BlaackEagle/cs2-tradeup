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

Couteaux et gants (les resultats d'un contrat) : leur prix d'echange chez
tradeit et leur valeur d'echange, c'est-a-dire ce que tradeit t'accorde si
tu les lui echanges (userPrice, lu par items-prices). Recherche par gold,
les moins recemment lus d'abord ; au premier releve, la liste rarity=Covert
de la boutique (une vingtaine de pages) en donne deja une bonne partie.
Pour un Doppler, la phase la moins chere fait foi, comme pour les marches.

Donnees publiques de la boutique, lues sans connexion : rien de personnel.
Si le releve echoue entierement, le fichier precedent est garde tant qu'il
a moins de 12 h, puis supprime.

    python scripts/fetch_tradeit_stock.py
"""

import json
import os
import re
import statistics
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_prices import CATALOG, MAX_CARRY_H, UA, SourceError, age_h, log, now  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "data", "tradeit.json")
API = os.environ.get("TRADEIT_API", "https://tradeit.gg/api/v2/inventory/data")   # faux serveur en test
PRICES_API = API.replace("/inventory/data", "/inventory/items-prices")
HEADERS = {"User-Agent": UA, "Accept": "application/json", "Referer": "https://tradeit.gg/csgo/trade"}
KEEP = 8                                                     # floats gardes par pile
PACE = float(os.environ.get("TRADEIT_PACE", 2.3))            # secondes entre deux requetes
BUDGET_S = float(os.environ.get("TRADEIT_BUDGET", 10 * 60))  # duree max du releve
SEARCH_SHARE = 0.4           # part du budget au plus pour les recherches quand un releve precedent existe
GOLD_SHARE = 0.25            # part du budget pour les couteaux et gants
GOLD_MAX_AGE_H = 36          # valeurs d'echange d'un gold gardees au plus
# phase d'un Doppler dans le nom tradeit ("Doppler Phase 2", "Gamma Doppler Emerald") ;
# seulement apres "Doppler" : "Hydra Gloves | Emerald" est une finition, pas une phase
PHASE = re.compile(r"(?<=Doppler) (Phase \d|Ruby|Sapphire|Black Pearl|Emerald)(?= \(|$)")
SAMPLES = ["AK-47 | The Empress (Field-Tested)", "M4A4 | Temukau (Field-Tested)"]
GOLD_SAMPLES = ["★ Butterfly Knife | Doppler (Factory New)", "★ Karambit | Doppler (Factory New)",
                "★ Sport Gloves | Vice (Field-Tested)"]


class RateLimited(Exception):
    pass


class Api:
    """Requetes espacees de PACE secondes ; 429 : pause croissante, puis abandon."""

    def __init__(self):
        self.last = 0.0
        self.calls = self.n429 = self.streak = 0

    def get(self, params):
        return self.call("GET", API, params=dict({"gameId": 730}, **params))

    def prices(self, group_ids):
        """Prix d'echange (sitePrice) et valeur d'echange (userPrice) de piles, par lots de 50."""
        d = self.call("POST", PRICES_API, json={"context": "trade", "groupIds": group_ids, "appId": 730})
        return (d or {}).get("data") or {}

    def call(self, method, url, **kw):
        err = None
        for attempt in range(3):
            wait = self.last + PACE - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = requests.request(method, url, headers=HEADERS, timeout=40, **kw)
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


def gold_names(catalog):
    """market_hash_name d'un couteau ou de gants (StatTrak compris) -> gold de base."""
    names = {}
    for name, g in catalog["golds"].items():
        st = name.replace("★ ", "★ StatTrak™ ", 1)
        if not g["wears"]:                         # couteau vanilla
            names[name] = name
            if g["st"]:
                names[st] = name
        for w in g["wears"]:
            names[f"{name} ({w})"] = name
            if g["st"]:
                names[f"{st} ({w})"] = name
    return names


def gold_hash(name, gnames):
    """Nom tradeit -> notre market_hash_name : "Doppler Phase 2" et "Doppler Ruby" -> "Doppler"."""
    h = PHASE.sub("", name or "")
    return h if h in gnames else None


def price_of(it):
    p = it.get("priceForTrade") or it.get("price")
    return int(p) if isinstance(p, (int, float)) and p > 0 else None


def lock_of(v):
    """Jours de blocage : un nombre, ou une liste (une valeur par exemplaire d'une pile)."""
    if isinstance(v, list):
        return max([lock_of(x) for x in v] or [0])
    return int(v) if isinstance(v, (int, float)) and v > 0 else 0


def float_of(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0 <= f <= 1 else None


def count_of(v):
    if isinstance(v, list):
        return len(v)
    return int(v) if isinstance(v, (int, float)) and v > 0 else None


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

    def add_line(offers, h, it, count):
        """Une ligne de la recherche : une pile (floats a lire), ou un exemplaire seul (float connu)."""
        p = price_of(it)
        lock = lock_of(it.get("tradeLockDay"))
        f = float_of(it.get("floatValue"))
        if it.get("assetId") is not None and f is not None:
            f = round(f, 10)
            same = next((o for o in offers.get(h, []) if o.get("g") is None and o["p"] == p), None)
            if same:
                same["n"] += 1
                same["fn"] += 1
                same["f"] = sorted(same["f"] + [f])[:KEEP]
                same["hi"] = max(same["hi"], f)
            else:
                offers.setdefault(h, []).append({"g": None, "p": p, "n": 1, "f": [f], "hi": f,
                                                 "at": stamp, "fn": 1, "lock": lock})
            return
        gid = it.get("groupId")
        if gid is None:
            return
        old = prev_by_group.get(gid) or {}
        o = {"g": gid, "p": p, "n": count_of(count) or old.get("n") or 1, "f": old.get("f") or [],
             "hi": old.get("hi"), "at": old.get("at"), "fn": old.get("fn"), "lock": old.get("lock", lock)}
        if o["at"] and age_h(o["at"]) > MAX_CARRY_H:
            o.update(f=[], hi=None, at=None, fn=None)
        offers.setdefault(h, []).append(o)

    # offres a jour : celles des Coverts cherches, sinon les precedentes
    offers = {}                                    # hash -> [offre]
    for base in catalog["coverts"]:
        if base in found:
            for h, rows in found[base].items():
                for it, count in rows:
                    try:
                        add_line(offers, h, it, count)
                    except Exception as e:                  # noqa: BLE001 - une ligne bizarre ne bloque pas le releve
                        errors.append(f"ligne : {type(e).__name__}")
        elif base in searched:
            for h, olds in prev_offers.get(base, {}).items():
                offers[h] = [dict(o) for o in olds]

    # 2. couteaux et gants : prix d'echange et valeur d'echange (ce que tradeit t'accorde)
    gnames = gold_names(catalog)
    prev_golds = {h: v for h, v in ((prev or {}).get("golds") or {}).items()
                  if h in gnames and age_h(v.get("at")) <= GOLD_MAX_AGE_H}
    gold_searched = {k: v for k, v in ((prev or {}).get("gold_searched") or {}).items()
                     if age_h(v) <= GOLD_MAX_AGE_H}
    t1, gold_budget = time.time(), BUDGET_S * GOLD_SHARE
    fresh, gsearched, listed = {}, set(), False    # hash -> {"p", "n", "gids": {groupId: prix}}

    def add_gold(it, count):
        h, p = gold_hash(it.get("name"), gnames), price_of(it)
        if not h or not p:
            return
        e = fresh.setdefault(h, {"p": p, "n": 0, "gids": {}})
        e["p"] = min(e["p"], p)                    # Doppler : la phase la moins chere
        e["n"] += count_of(count) or 1
        if it.get("groupId") is not None:
            e["gids"][str(it["groupId"])] = p

    if not prev_golds and not stopped:
        # premier releve : la liste rarity=Covert de la boutique (incomplete mais large)
        listed, seen = True, set()
        for page in range(60):
            if time.time() - t1 > gold_budget * 0.5:
                break
            try:
                d = api.get({"rarity": "Covert", "offset": page * 500, "limit": 500})
            except RateLimited as e:
                stopped = str(e)
                break
            except SourceError as e:
                errors.append(f"liste : {e}")
                break
            rows = d.get("items") or []
            if not rows:
                break
            counts = d.get("counts") or {}
            for it in rows:
                k = it.get("groupId") if it.get("assetId") is None else ("a", it.get("assetId"))
                if k not in seen:
                    seen.add(k)
                    add_gold(it, counts.get(str(it.get("groupId"))))
    else:
        bases = sorted(set(gnames.values()), key=lambda b: (b in gold_searched, gold_searched.get(b, "")))
        for base in bases:
            if stopped or time.time() - t1 > gold_budget * 0.75:
                break
            vanilla = not catalog["golds"][base]["wears"]
            try:
                d = api.get({"offset": 0, "limit": 500 if vanilla else 200, "searchValue": base.replace("★ ", "", 1)})
            except RateLimited as e:
                stopped = str(e)
                break
            except SourceError as e:
                errors.append(f"recherche gold : {e}")
                continue
            counts = d.get("counts") or {}
            for it in d.get("items") or []:
                h = gold_hash(it.get("name"), gnames)
                if h and gnames[h] == base:
                    add_gold(it, counts.get(str(it.get("groupId"))))
            gsearched.add(base)
            gold_searched[base] = stamp

    # valeur d'echange exacte des piles lues (lots de 50)
    gids, user = [g for e in fresh.values() for g in e["gids"]], {}
    for i in range(0, len(gids), 50):
        if stopped or time.time() - t1 > gold_budget:
            break
        try:
            data = api.prices([int(g) if g.isdigit() else g for g in gids[i:i + 50]])
        except RateLimited as e:
            stopped = str(e)
            break
        except SourceError as e:
            errors.append(f"items-prices : {e}")
            continue
        for g, v in data.items():
            u = v.get("userPrice") if isinstance(v, dict) else None
            if isinstance(u, (int, float)) and u > 0:
                user[str(g)] = int(u)

    golds = {h: v for h, v in prev_golds.items() if gnames[h] not in gsearched}
    for h, e in fresh.items():
        us = [user[g] for g in e["gids"] if g in user]
        old = prev_golds.get(h) or {}
        u = min(us) if us else (old.get("u") if old.get("p") == e["p"] else None)
        golds[h] = {"p": e["p"], "u": u, "n": e["n"], "at": stamp}
    log(f"[stock] couteaux et gants : {len(fresh)} lus cette fois ({'liste de la boutique' if listed else f'{len(gsearched)} recherches'}), "
        f"{len(golds)} avec un prix d'echange dont {sum(1 for v in golds.values() if v.get('u'))} avec leur valeur d'echange "
        f"({time.time() - t1:.0f}s)")

    # 3. ouverture des piles de Coverts, les plus utiles d'abord
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
        items = [it for it in d.get("items") or [] if float_of(it.get("floatValue")) is not None]
        fl = sorted(float_of(it["floatValue"]) for it in items)
        opened += 1
        if not fl:                                 # pile vendue entre-temps
            o["n"] = 0
            continue
        o.update(f=[round(x, 10) for x in fl[:KEEP]], hi=round(fl[-1], 10), at=stamp, fn=len(fl), n=len(fl),
                 lock=max(lock_of(it.get("tradeLockDay")) for it in items))
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
        "golds": len(golds), "golds_user": sum(1 for v in golds.values() if v.get("u")),
        "requests": api.calls, "http429": api.n429, "errors": len(errors),
        "complete": with_floats == len(all_groups) and len(found) == len(catalog["coverts"]),
    }
    out = {"v": 2, "updated_at": stamp, "currency": "USD", "unit": "cents", "keep": KEEP,
           "searched": searched, "gold_searched": gold_searched, "stats": stats, "items": items, "golds": golds}
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
    for n in GOLD_SAMPLES:
        v = golds.get(n)
        if v:
            u = f", tradeit en donne {v['u'] / 100:.2f} $" if v.get("u") else ""
            log(f"  {n:<44} {v['p'] / 100:.2f} $ d'echange{u}")
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
