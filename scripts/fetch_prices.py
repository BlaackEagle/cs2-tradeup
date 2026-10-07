#!/usr/bin/env python3
"""
Recupere les prix actuels de tous les Coverts de caisse, de tous les golds
(couteaux / gants) et des caisses, sur plusieurs marches, et ecrit
site/data/prices.json.

Chaque source est independante : si l'une tombe (rate limit, API changee,
cle manquante), les autres continuent, et les derniers prix connus de la
source en panne sont repris depuis le fichier precedent avec leur date
d'origine. Le site affiche l'age de chaque source.

Sources
  skinport      API publique, tous les items en un appel
  csfloat       liste de prix (CSFLOAT_API_KEY optionnelle)
  dmarket       prix agreges par lots de 100 titres
  steam         recherche du Steam Market par categorie (lent, rate limite)
  steam_weekly  releve Steam publie sur GitHub par ByMykel (filet de securite ;
                sa date est affichee, il peut avoir plusieurs semaines)

    python scripts/fetch_prices.py
    python scripts/fetch_prices.py --previous https://.../data/prices.json
    python scripts/fetch_prices.py --only skinport,steam_weekly
"""

import argparse
import json
import os
import re
import statistics
import sys
import time
from datetime import datetime, timezone

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.join(HERE, "..", "site", "data", "catalog.json")
OUT = os.path.join(HERE, "..", "site", "data", "prices.json")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
SOURCES = ["skinport", "csfloat", "dmarket", "steam", "steam_weekly"]
LABELS = {
    "skinport": "Skinport",
    "csfloat": "CSFloat",
    "dmarket": "DMarket",
    "steam": "Steam Market",
    "steam_weekly": "Steam (relevé GitHub)",
}
KEYS = {"skinport": "sk", "csfloat": "cf", "dmarket": "dm",
        "steam": "st", "steam_weekly": "fb"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(*a):
    print(*a, flush=True)


class SourceError(Exception):
    pass


# ------------------------------------------------------------ noms a suivre

def wanted_names(catalog):
    """Tous les market_hash_name utiles au simulateur."""
    names = set()
    for name, c in catalog["coverts"].items():
        for w in c["wears"]:
            names.add(f"{name} ({w})")
            if c["st"]:
                names.add(f"StatTrak™ {name} ({w})")
    for name, g in catalog["golds"].items():
        st_name = name.replace("★ ", "★ StatTrak™ ", 1)
        if not g["wears"]:                       # couteau vanilla
            names.add(name)
            if g["st"]:
                names.add(st_name)
            continue
        for w in g["wears"]:
            names.add(f"{name} ({w})")
            if g["st"]:
                names.add(f"{st_name} ({w})")
    for col in catalog["collections"]:
        names.add(col["hash"])
    return names


# ------------------------------------------------------------------ sources

def http(method, url, retries=4, **kw):
    kw.setdefault("timeout", 60)
    headers = {"User-Agent": UA, "Accept": "application/json"}
    headers.update(kw.pop("headers", {}))
    last = None
    for attempt in range(retries):
        try:
            r = requests.request(method, url, headers=headers, **kw)
        except requests.exceptions.ProxyError as e:
            # refus d'un proxy d'entreprise : reessayer ne changera rien
            raise SourceError(f"bloque par le proxy reseau ({e.__class__.__name__})")
        except requests.RequestException as e:
            last = f"{type(e).__name__}: {e}"
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last = f"HTTP {r.status_code}"
            wait = int(r.headers.get("Retry-After", 0) or 0) or 20 * (attempt + 1)
            log(f"    {last}, nouvel essai dans {wait}s")
            time.sleep(min(wait, 120))
            continue
        return r
    raise SourceError(last or "echec reseau")


def fetch_skinport(names):
    r = http("GET", "https://api.skinport.com/v1/items",
             params={"app_id": 730, "currency": "USD", "tradable": 0},
             headers={"Accept-Encoding": "br"})
    if r.status_code != 200:
        raise SourceError(f"HTTP {r.status_code}: {r.text[:200]}")
    out = {}
    for it in r.json():
        n = it.get("market_hash_name")
        p = it.get("min_price")
        if n in names and p:
            out[n] = [round(float(p), 2), it.get("quantity")]
    return out


def fetch_csfloat(names):
    headers = {}
    key = os.environ.get("CSFLOAT_API_KEY", "").strip()
    if key:
        headers["Authorization"] = key
    r = http("GET", "https://csfloat.com/api/v1/listings/price-list",
             headers=headers)
    if r.status_code in (401, 403):
        raise SourceError(f"HTTP {r.status_code} : cle API CSFloat requise "
                          f"(secret CSFLOAT_API_KEY)" if not key else
                          f"HTTP {r.status_code} : cle API refusee")
    if r.status_code != 200:
        raise SourceError(f"HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    if isinstance(data, dict):
        data = data.get("data") or data.get("items") or []
    out = {}
    for it in data:
        n = it.get("market_hash_name")
        p = it.get("min_price")
        if n in names and p:
            out[n] = [round(p / 100.0, 2), it.get("quantity")]   # centimes
    return out


def _dm_new(batch):
    r = http("POST", "https://api.dmarket.com/marketplace-api/v1/aggregated-prices",
             json={"filter": {"game": "a8db", "titles": batch},
                   "limit": str(len(batch)), "cursor": ""})
    if r.status_code != 200:
        raise SourceError(f"aggregated-prices HTTP {r.status_code}: {r.text[:160]}")
    rows = r.json().get("aggregatedPrices") or []
    return {x.get("title"): (x.get("offerBestPrice"), x.get("offerCount"))
            for x in rows}


def _dm_old(batch):
    params = [("Titles", t) for t in batch] + [("Limit", str(len(batch)))]
    r = http("GET", "https://api.dmarket.com/price-aggregator/v1/aggregated-prices",
             params=params)
    if r.status_code != 200:
        raise SourceError(f"price-aggregator HTTP {r.status_code}: {r.text[:160]}")
    rows = r.json().get("AggregatedTitles") or []
    return {x.get("MarketHashName"): ((x.get("Offers") or {}).get("BestPrice"),
                                      (x.get("Offers") or {}).get("Count"))
            for x in rows}


def _num(v):
    if v is None:
        return None
    if isinstance(v, dict):                 # {"Amount": "...", "Currency": "USD"}
        v = v.get("Amount") or v.get("amount") or v.get("USD")
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


DM_PROBE = ["AK-47 | Bloodsport (Field-Tested)", "AWP | Asiimov (Field-Tested)",
            "★ Karambit | Doppler (Factory New)", "AK-47 | The Empress (Field-Tested)",
            "★ Butterfly Knife | Doppler (Factory New)"]


def fetch_dmarket(names, reference=None):
    titles = sorted(names)
    batches = [titles[i:i + 100] for i in range(0, len(titles), 100)]
    probe = [t for t in DM_PROBE if t in names] or titles[:5]
    method, errors = None, []
    # un endpoint qui repond 200 sans aucun prix ne compte pas comme valide
    for fn in (_dm_new, _dm_old):
        try:
            rows = fn(probe)
            if any(_num(p) for p, _ in rows.values()):
                method = fn
                break
            errors.append(f"{fn.__name__} : reponse vide {json.dumps(rows)[:120]}")
        except SourceError as e:
            errors.append(str(e))
    if not method:
        raise SourceError(" | ".join(errors))
    log(f"    methode DMarket : {method.__name__}")

    raw = {}
    for i, b in enumerate(batches):
        try:
            raw.update(method(b))
        except SourceError as e:
            log(f"    lot {i} ignore : {e}")
        time.sleep(0.4)

    out = {}
    for n, (p, q) in raw.items():
        v = _num(p)
        if n in names and v:
            out[n] = [v, int(q) if str(q or "").isdigit() else q]

    # Le format des prix DMarket varie selon l'endpoint (dollars ou centimes).
    # On cale l'echelle sur une source de reference quand on en a une.
    scale = 1.0
    if reference:
        ratios = [out[n][0] / reference[n][0] for n in out
                  if n in reference and reference[n][0]]
        if len(ratios) >= 20:
            med = statistics.median(ratios)
            if 50 < med < 200:
                scale = 0.01
            log(f"    ratio median DMarket/reference = {med:.2f} -> echelle {scale}")
    for n in out:
        out[n][0] = round(out[n][0] * scale, 2)
    return out


STEAM_CATEGORIES = [
    ("Coverts", {"category_730_Rarity[]": "tag_Rarity_Ancient_Weapon"}),
    ("Couteaux", {"category_730_Type[]": "tag_CSGO_Type_Knife"}),
    ("Gants", {"category_730_Type[]": "tag_Type_Hands"}),
    ("Caisses", {"category_730_Type[]": "tag_CSGO_Type_WeaponCase"}),
]


def fetch_steam(names, budget_s=900, delay=4.0):
    """Renvoie (prix, complet). complet=False si le budget temps a coupe."""
    out, t0 = {}, time.time()
    for label, cat in STEAM_CATEGORIES:
        start, total = 0, None
        while total is None or start < total:
            if time.time() - t0 > budget_s:
                log(f"    budget temps atteint pendant {label}")
                if not out:
                    raise SourceError("budget temps atteint sans resultat")
                return out, False
            params = {"query": "", "start": start, "count": 100,
                      "search_descriptions": 0, "sort_column": "name",
                      "sort_dir": "asc", "appid": 730, "norender": 1}
            params.update(cat)
            r = http("GET", "https://steamcommunity.com/market/search/render/",
                     params=params, retries=5)
            if r.status_code != 200:
                raise SourceError(f"HTTP {r.status_code} sur {label}")
            d = r.json()
            if not d.get("success"):
                raise SourceError(f"reponse sans succes sur {label}")
            total = d.get("total_count") or 0
            results = d.get("results") or []
            if not results:
                break
            for it in results:
                n = it.get("hash_name")
                txt = it.get("sell_price_text") or ""
                if start == 0 and "$" not in txt:
                    raise SourceError(f"devise inattendue : {txt!r}")
                if n in names and it.get("sell_price"):
                    out[n] = [round(it["sell_price"] / 100.0, 2),
                              it.get("sell_listings")]
            start += len(results)
            time.sleep(delay)
        log(f"    {label} : {total} resultats parcourus")
    return out, True


def fetch_steam_weekly(names):
    r = http("GET", "https://raw.githubusercontent.com/ByMykel/"
                    "counter-strike-price-tracker/main/static/latest.json")
    if r.status_code != 200:
        raise SourceError(f"HTTP {r.status_code}")
    d = r.json()
    out = {n: [round(c / 100.0, 2), None]
           for n, c in d.get("prices", {}).items() if n in names and c}
    return out, d.get("metadata", {}).get("updated_at")


def fetch_fx(previous):
    try:
        r = http("GET", "https://api.frankfurter.app/latest",
                 params={"from": "USD", "to": "EUR"}, retries=2, timeout=20)
        if r.status_code == 200:
            return {"EUR": r.json()["rates"]["EUR"], "updated_at": now()}
    except (SourceError, KeyError, ValueError):
        pass
    fx = (previous or {}).get("fx")
    return fx or {"EUR": 0.86, "updated_at": None}


# --------------------------------------------------------------------- main

def load_previous(spec):
    if not spec:
        return None
    try:
        if spec.startswith("http"):
            r = requests.get(spec, timeout=30, headers={"User-Agent": UA})
            return r.json() if r.status_code == 200 else None
        with open(spec, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:                       # noqa: BLE001
        log(f"fichier precedent illisible ({e}), on repart de zero")
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default=CATALOG)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--previous", help="prices.json precedent (chemin ou URL)")
    ap.add_argument("--only", help="sources a interroger, separees par des virgules")
    ap.add_argument("--steam-every", type=float, default=3.0,
                    help="heures minimum entre deux releves Steam complets")
    args = ap.parse_args()

    with open(args.catalog, encoding="utf-8") as f:
        catalog = json.load(f)
    names = wanted_names(catalog)
    log(f"{len(names)} market_hash_name a coter")

    # releve precedent : celui du site en ligne, sinon celui du depot
    prev = (load_previous(args.previous) if args.previous else None) or load_previous(args.out)
    prev_sources = (prev or {}).get("sources", {})
    prev_items = (prev or {}).get("items", {})
    only = set(args.only.split(",")) if args.only else set(SOURCES)

    # "complete" = la source a ete relevee entierement : un item absent veut
    # alors dire "plus en vente", on ne reprend pas son ancien prix.
    results, complete, status = {}, {}, {}
    for src in SOURCES:
        k = KEYS[src]
        status[src] = {"label": LABELS[src], "ok": False, "updated_at": None,
                       "count": 0, "error": None, "stale": False}
        if src not in only:
            status[src]["error"] = "non interrogee"
            continue

        if src == "steam":
            last = prev_sources.get(k, {})
            if last.get("ok") and not last.get("stale") and last.get("updated_at"):
                age = (datetime.now(timezone.utc)
                       - datetime.fromisoformat(last["updated_at"])).total_seconds()
                if age < args.steam_every * 3600:
                    # releve recent : on garde son statut tel quel (ok, date)
                    status[src] = dict(last, skipped=True)
                    log(f"[steam] saute : releve complet il y a {age / 3600:.1f} h")
                    continue

        log(f"[{src}] ...")
        t = time.time()
        try:
            full = True
            if src == "skinport":
                data, stamp = fetch_skinport(names), now()
            elif src == "csfloat":
                data, stamp = fetch_csfloat(names), now()
            elif src == "dmarket":
                data, stamp = fetch_dmarket(names, results.get("skinport")), now()
            elif src == "steam":
                (data, full), stamp = fetch_steam(names), now()
            else:
                data, stamp = fetch_steam_weekly(names)
            if not data:
                raise SourceError("aucun prix recupere")
            results[src], complete[src] = data, full
            status[src].update(ok=True, updated_at=stamp, count=len(data),
                               error=None if full else "releve partiel (budget temps)")
            log(f"[{src}] {len(data)} prix en {time.time() - t:.0f}s")
        except Exception as e:                   # noqa: BLE001
            status[src]["error"] = str(e)[:300]
            log(f"[{src}] ECHEC : {status[src]['error']}")

    # Fusion : prix frais quand la source a repondu, sinon derniers prix
    # connus de cette source (avec leur date d'origine, affichee sur le site).
    items = {}
    for src in SOURCES:
        k = KEYS[src]
        fresh = results.get(src, {})
        for n, v in fresh.items():
            items.setdefault(n, {})[k] = v
        if complete.get(src):
            continue
        carried = 0
        for n, v in prev_items.items():
            if k in v and n in names and n not in fresh:
                items.setdefault(n, {})[k] = v[k]
                carried += 1
        if carried and src not in results:
            old = prev_sources.get(k, {})
            if not status[src].get("skipped"):
                status[src].update(updated_at=old.get("updated_at"), stale=True)
            status[src]["count"] = carried
            log(f"[{src}] {carried} prix repris du releve du {old.get('updated_at')}")

    out = {
        "updated_at": now(),
        "currency": "USD",
        "fx": fetch_fx(prev),
        "order": [KEYS[s] for s in SOURCES],
        "sources": {KEYS[s]: status[s] for s in SOURCES},
        "items": dict(sorted(items.items())),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    covered = sum(1 for n in names if n in items)
    log(f"\n{covered}/{len(names)} items cotes -> {args.out} "
        f"({os.path.getsize(args.out) // 1024} Ko)")
    for s in SOURCES:
        st = status[s]
        etat = "OK" if st["ok"] else ("ancien" if st["stale"] else "KO")
        log(f"  {LABELS[s]:<22}{etat:<8}{st['count']:>6}  {st['error'] or ''}")
    # echec du job seulement si on n'a strictement rien
    return 0 if items else 1


if __name__ == "__main__":
    sys.exit(main())
