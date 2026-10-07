# Trade-Up Gold CS2

Simulateur qui répond à une question : **quelle est la façon la moins chère
d'obtenir un couteau ou des gants précis ?** Pour la cible choisie, il compare
toutes les méthodes possibles :

- **acheter directement**, au meilleur prix parmi Skinport, CSFloat, DMarket et le Steam Market ;
- **le trade-up 5 Coverts → gold** (mise à jour CS2 du 23 octobre 2025), avec les 5 inputs
  optimaux, la chance d'avoir la cible, l'usure garantie et le mode d'emploi ;
- **l'ouverture de caisses**, pour comparaison.

Le chiffre clé est le **coût moyen pour avoir la cible** : ce qu'on dépense en
moyenne avant de tenir la cible, en revendant au passage tout ce qui n'est pas
la cible.

## Fonctionnement

```
GitHub Actions, toutes les 30 min
  scripts/build_catalog.py   caisses → Coverts → couteaux/gants (données du jeu, ByMykel/CSGO-API)
  scripts/fetch_prices.py    prix sur chaque marché → site/data/prices.json
  → publication de site/ sur GitHub Pages

Navigateur
  site/engine.js             calculs (aucune dépendance, testé sous Node)
  site/app.js                interface
```

Chaque source de prix est indépendante : si l'une tombe (rate limit, API
modifiée, clé absente), les autres continuent et ses derniers prix connus sont
repris avec leur date d'origine. Le site affiche l'âge de chaque source et
prévient quand aucun prix n'est en direct.

## Clé CSFloat (optionnelle)

Sans clé, CSFloat peut refuser la liste de prix. Pour l'ajouter :
**Settings → Secrets and variables → Actions → New repository secret**,
nom `CSFLOAT_API_KEY`, valeur = ta clé (csfloat.com → Profil → Developers).
Elle reste chiffrée côté GitHub et n'apparaît jamais dans le site.

## Modèle de calcul

- 5 Coverts, tous StatTrak™ ou tous normaux. Chaque input pèse 1/5 : la caisse
  d'un input est tirée avec cette probabilité, puis un gold uniformément dans son pool.
- Phases Doppler : Valve ne publie pas les taux et les sources divergent. Par
  défaut une finition = une chance ; l'option « chaque phase = une chance »
  donne l'autre lecture (et change beaucoup le résultat pour un Doppler).
- Float de sortie = min + moyenne des positions normalisées des inputs × (max − min).
  L'optimiseur prend le pire float de chaque palier acheté : l'usure annoncée est garantie.
- Revente d'un gold = prix le plus bas parmi son usure et les usures meilleures
  (une annonce isolée hors de prix dans une mauvaise usure ne gonfle pas la valeur),
  moins les frais de revente. Cette valeur ne monte jamais quand le float monte,
  ce qui rend l'élagage de l'optimiseur exact.

## Tests

```bash
node tests/engine.test.js     # maths, optimiseur contre une recherche exhaustive
node tests/big_check.js       # idem sur les golds présents dans 11 caisses (lent)
```

En local : `python3 scripts/fetch_prices.py` puis
`python3 -m http.server --directory site`.

Outil indépendant, non affilié à Valve ni aux marchés cités.
