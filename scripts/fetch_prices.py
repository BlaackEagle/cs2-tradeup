#!/usr/bin/env python3
"""
Recupere les prix actuels de tous les Coverts de caisse, de tous les golds
(couteaux / gants) et des caisses, sur plusieurs marches, et ecrit
site/data/prices.json, EN EUROS.

Devise : Skinport cote nativement en euros. CSFloat et DMarket cotent en
dollars (Steam aussi depuis les serveurs GitHub, situes aux Etats-Unis) : ces
prix sont convertis au taux de reference BCE du jour, ecrit dans le fichier
et affiche sur le site.

Fraicheur : chaque source est independante. Si l'une tombe (rate limit, API
changee, cle manquante), les autres continuent ; les derniers prix connus de
la source en panne sont repris s'ils ont moins de 12 h, avec leur date
d'origine. Au-dela ils sont abandonnes : mieux vaut "pas de prix" qu'un prix
perime.

Sources
  skinport      API publique, tous les items en un appel                (EUR)
  csfloat       liste de prix, CSFLOAT_API_KEY optionnelle             (USD)
  dmarket       meilleures offres, par lots de 100 titres              (USD)
  steam         recherche du Steam Market par categorie, rate limitee  (USD)
  steam_weekly  ancien releve Steam publie sur GitHub par ByMykel      (USD)
                -> exclu des calculs par defaut sur le site

    python scripts/fetch_prices.py
    python scripts/fetch_prices.py --previous https://.../data/prices.json
    python scripts/fetch_prices.py --only skinport,steam_weekly
"""

import argparse
import json
import os
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
    "steam_weekly": "Steam (ancien relevé)",
}
KEYS = {"skinport": "sk", "csfloat": "cf", "dmarket": "dm",
        "steam": "st", "steam_weekly": "fb"}
NATIVE = {"skinport": "EUR", "csfloat": "USD", "dmarket": "USD",
          "steam": "USD", "steam_weekly": "USD"}
LIVE = {"skinport", "csfloat", "dmarket", "steam"}
MAX_CARRY_H = 12            # age max des prix repris d'un releve precedent

# items affiches dans les logs pour controle a l'oeil
SAMPLES = ["★ Butterfly Knife | Doppler (Factory New)", "★ Karambit | Doppler (Factory New)",
           "AK-47 | The Empress (Field-Tested)", "AK-47 | Bloodsport (Field-Tested)",
           "★ Sport Gloves | Vice (Field-Tested)"]


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def age_h(iso):
    if not iso:
        return float("inf")
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600


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
            if attempt + 1 < retries:
                wait = int(r.headers.get("Retry-After", 0) or 0) or 20 * (attempt + 1)
                log(f"    {last}, nouvel essai dans {wait}s")
                time.sleep(min(wait, 120))
            continue
        return r
    raise SourceError(last or "echec reseau")


def fetch_skinport(names):
    r = http("GET", "https://api.skinport.com/v1/items",
             params={"app_id": 730, "currency": "EUR", "tradable": 0},
             headers={"Accept-Encoding": "br"})
    if r.status_code != 200:
        raise SourceError(f"HTTP {r.status_code}: {r.text[:200]}")
    out = {}
    for it in r.json():
        n = it.get("market_hash_name")
        p = it.get("min_price")
        if n in names and p:
            if it.get("currency") not in (None, "EUR"):
                raise SourceError(f"devise inattendue : {it.get('currency')}")
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


def fetch_dmarket(names, reference_usd=None):
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
    # On cale l'echelle sur une source de reference en dollars.
    scale = 1.0
    if reference_usd:
        ratios = [out[n][0] / reference_usd[n][0] for n in out
                  if n in reference_usd and reference_usd[n][0]]
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
    out, t0, first = {}, time.time(), True
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
            # premiere requete : si l'IP du serveur est deja limitee par Steam,
            # inutile d'insister plusieurs minutes, on reessaiera au run suivant
            r = http("GET", "https://steamcommunity.com/market/search/render/",
                     params=params, retries=2 if first else 5)
            first = False
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
    """Taux USD -> EUR de reference de la BCE (dernier jour ouvre)."""
    tries = [
        ("https://api.frankfurter.dev/v1/latest", {"base": "USD", "symbols": "EUR"}),
        ("https://api.frankfurter.app/latest", {"from": "USD", "to": "EUR"}),
    ]
    for url, params in tries:
        try:
            r = http("GET", url, params=params, retries=2, timeout=20)
            if r.status_code != 200:
                continue
            d = r.json()
            rate = float(d["rates"]["EUR"])
            if 0.5 < rate < 1.5:
                return {"USD_EUR": round(rate, 6), "date": d.get("date"),
                        "source": "BCE via " + url.split("/")[2],
                        "updated_at": now(), "stale": False}
        except (SourceError, KeyError, ValueError, TypeError):
            continue
    old = (previous or {}).get("fx") or {}
    rate = old.get("USD_EUR") or old.get("EUR")
    if rate:
        return {"USD_EUR": rate, "date": old.get("date"), "source": old.get("source"),
                "updated_at": old.get("updated_at"), "stale": True}
    return {"USD_EUR": 0.86, "date": None, "source": "valeur par defaut",
            "updated_at": None, "stale": True}


def to_eur(data, cur, rate):
    if cur == "EUR":
        return data
    return {n: [round(p * rate, 2), q] for n, (p, q) in data.items()}


def consistency(items):
    """Ecart median entre sources sur les items cotes des deux cotes."""
    out = {}
    for a, b in (("sk", "cf"), ("dm", "cf"), ("st", "cf"), ("dm", "sk")):
        r = [v[a][0] / v[b][0] for v in items.values()
             if a in v and b in v and v[b][0] >= 5 and v[a][0] > 0]
        if len(r) >= 30:
            out[f"{a}/{b}"] = {"median": round(statistics.median(r), 3), "n": len(r)}
    return out


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

    fx = fetch_fx(prev)
    rate = fx["USD_EUR"]
    log(f"taux : 1 USD = {rate} EUR ({fx.get('source')}, {fx.get('date')})"
        + (" -- ANCIEN" if fx.get("stale") else ""))
    # un releve precedent en dollars (ancien format) est converti au taux du jour
    prev_rate = rate if (prev or {}).get("currency", "USD") == "USD" else 1.0

    # "complete" = la source a ete relevee entierement : un item absent veut
    # alors dire "plus en vente", on ne reprend pas son ancien prix.
    results, native, complete, status = {}, {}, {}, {}
    for src in SOURCES:
        k = KEYS[src]
        status[src] = {"label": LABELS[src], "ok": False, "updated_at": None,
                       "count": 0, "error": None, "stale": False,
                       "native": NATIVE[src]}
        if src not in only:
            status[src]["error"] = "non interrogee"
            continue

        if src == "steam":
            last = prev_sources.get(k, {})
            if last.get("ok") and not last.get("stale") and age_h(last.get("updated_at")) < args.steam_every:
                # releve recent : on garde son statut tel quel (ok, date)
                status[src] = dict(last, skipped=True, native=NATIVE[src])
                log(f"[steam] saute : releve complet il y a {age_h(last['updated_at']):.1f} h")
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
                ref = native.get("csfloat") or {
                    n: [p / rate, q] for n, (p, q) in native.get("skinport", {}).items()}
                data, stamp = fetch_dmarket(names, ref), now()
            elif src == "steam":
                (data, full), stamp = fetch_steam(names), now()
            else:
                data, stamp = fetch_steam_weekly(names)
            if not data:
                raise SourceError("aucun prix recupere")
            native[src] = data
            results[src], complete[src] = to_eur(data, NATIVE[src], rate), full
            status[src].update(ok=True, updated_at=stamp, count=len(data),
                               error=None if full else "releve partiel (budget temps)")
            log(f"[{src}] {len(data)} prix en {time.time() - t:.0f}s")
        except Exception as e:                   # noqa: BLE001
            status[src]["error"] = str(e)[:300]
            log(f"[{src}] ECHEC : {status[src]['error']}")

    # Fusion : prix frais quand la source a repondu, sinon derniers prix
    # connus de cette source s'ils sont assez recents (date d'origine affichee).
    items = {}
    for src in SOURCES:
        k = KEYS[src]
        fresh = results.get(src, {})
        for n, v in fresh.items():
            items.setdefault(n, {})[k] = v
        if complete.get(src):
            continue
        old = prev_sources.get(k, {})
        if src in LIVE and age_h(old.get("updated_at")) > MAX_CARRY_H:
            if not fresh and old.get("updated_at"):
                log(f"[{src}] ancien releve du {old.get('updated_at')} abandonne (> {MAX_CARRY_H} h)")
            continue
        carried = 0
        for n, v in prev_items.items():
            if k in v and n in names and n not in fresh:
                p, q = v[k]
                items.setdefault(n, {})[k] = [round(p * prev_rate, 2), q]
                carried += 1
        if carried and src not in results:
            if not status[src].get("skipped"):
                status[src].update(updated_at=old.get("updated_at"), stale=True)
            status[src]["count"] = carried
            log(f"[{src}] {carried} prix repris du releve du {old.get('updated_at')}")

    checks = consistency(items)
    out = {
        "updated_at": now(),
        "currency": "EUR",
        "fx": fx,
        "order": [KEYS[s] for s in SOURCES],
        "sources": {KEYS[s]: status[s] for s in SOURCES},
        "checks": checks,
        "items": dict(sorted(items.items())),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    covered = sum(1 for n in names if n in items)
    live = sum(1 for n in names if any(k in items.get(n, {}) for k in ("sk", "cf", "dm", "st")))
    log(f"\n{covered}/{len(names)} items cotes, dont {live} avec un prix live "
        f"-> {args.out} ({os.path.getsize(args.out) // 1024} Ko)")
    for s in SOURCES:
        st = status[s]
        etat = "OK" if st["ok"] else ("ancien" if st["stale"] else "KO")
        log(f"  {LABELS[s]:<22}{etat:<8}{st['count']:>6}  {st['error'] or ''}")
    log("\ncoherence entre sources (rapport median, ~1.0 attendu) :")
    for pair, c in checks.items():
        log(f"  {pair:<6} {c['median']:.3f}  sur {c['n']} items")
    log("\ncontrole a l'oeil (EUR) :")
    for n in SAMPLES:
        v = items.get(n, {})
        log(f"  {n:<46} " + "  ".join(f"{k}={v[k][0]:.2f}" for k in ("sk", "cf", "dm", "st", "fb") if k in v))
    # echec du job seulement si on n'a strictement rien
    return 0 if items else 1


if __name__ == "__main__":
    sys.exit(main())
