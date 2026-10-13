# Kronos SMC: fonctionnement et validation

## Ce que fait le mode SMC

Le mode SMC est une lecture mecanique des bougies OHLC fournies par le serveur. Il ne lit pas l'iframe TradingView et ne prend pas de capture d'ecran du graphique integre. Les fournisseurs OHLC doivent fournir l'ouverture, le plus haut, le plus bas, la cloture et l'heure de chaque bougie. Le moteur ignore les bougies encore ouvertes.

Price Action reste le choix par defaut. Le mode SMC se selectionne dans la console et affiche un diagnostic de recherche. Il retourne toujours `AUCUN SIGNAL`; ses niveaux indicatifs ne sont pas copiables et ne declenchent aucun ordre.

## Regles actuellement implementees

1. **Biais de contexte**: EMA20 et EMA50 sur une unite superieure. Le biais est haussier si la cloture confirmee est au-dessus d'EMA20 et EMA20 au-dessus d'EMA50; inversement pour le biais baissier. Sinon le biais est neutre.
2. **Sweep et reprise**: la bougie depasse le plus haut ou le plus bas des 20 bougies precedentes, cloture de nouveau dans le range et cloture dans le sens de la reprise.
3. **Structure**: pivots confirmes avec deux bougies de part et d'autre. Apres le sweep, le prix doit cloturer au-dela du pivot oppose dans le sens du biais. Le setup expire apres cinq bougies de l'unite d'entree.
4. **Deplacement**: corps de bougie d'au moins 0,6 ATR(14), cloture dans le quart directionnel de la bougie.
5. **Zone**: FVG trois bougies si le desequilibre correspondant est present. Sinon, la premiere bougie opposee parmi les cinq precedentes peut servir de zone OB de repli. La zone expire apres douze bougies ou est invalidee par une cloture au-dela de son bord.
6. **Retest**: une bougie ulterieure recouvre la zone, puis cloture dans le sens du setup au-dela du milieu de zone. Le biais de contexte doit encore etre aligne.
7. **OTE et liquidite**: niveaux affiches comme reperes informatifs; ils ne sont pas des filtres valides par ce backtest.

Pour le scalping selectionne en M1, Kronos utilise M5 comme unite du setup et M15 comme contexte. En M5, il utilise M5/M15. Les autres choix utilisent l'unite selectionnee et un contexte superieur selon le plan du moteur. Si l'historique exact, son horodatage, sa fraicheur ou la provenance commune manquent, le moteur bloque la validation du setup.

## Lecture du panneau

- Les cinq cases montrent le biais, le sweep, la structure, le deplacement avec zone, puis le retest.
- Une zone FVG/OB est une zone potentielle de reaction; elle n'est pas une prediction certaine.
- Les niveaux affiches a titre indicatif sont l'entree de simulation, l'invalidation au-dela de l'extreme du sweep avec un tampon de 0,1 ATR (minimum deux ticks), et une cible theorique a 1,5R.
- Il n'y a ni pourcentage de reussite estime, ni copie SL/TP, ni execution automatique en mode SMC.
- Un widget TradingView embarque dans une iframe ne fournit pas ses donnees internes au moteur. La lecture SMC passe par les historiques OHLC directs du fournisseur de donnees.

## Backtest relie au moteur de production

La sixieme variante du script de recherche appelle maintenant le meme `analyzeKronosSmc` que la console. Le backtest utilise les bougies M1 bid/ask Deriv Demo, reechantillonnees en M5/M15, une chauffe de 30 jours, cinq plis chronologiques de 50 jours, un cout de slippage d'un tick de chaque cote, un filtre de cout maximal de 0,15R, un stop structurel, une cible 1,5R et une duree maximale de 60 minutes. Les variantes 1 a 5 restent des etapes d'ablation historiques.

Sur la periode disponible du 31 janvier au 8 octobre 2026, la variante stricte avec FVG ou OB puis retest a donne:

| Cout de spread | Trades | Gagnants | R moyen / trade | Profit factor | Plis positifs |
|---:|---:|---:|---:|---:|---:|
| 1x observe | 6 | 16,7 % | -0,444R | 0,174 | 1/5 |
| 1,5x | 6 | 16,7 % | -0,449R | 0,168 | 1/5 |
| 2x | 6 | 16,7 % | -0,454R | 0,162 | 1/5 |

Ce resultat ne valide pas une rentabilite; six trades ne suffisent pas a estimer une performance stable. Le panneau SMC est donc un outil d'observation/recherche. Le signal Price Action reste le mode par defaut.

## Validation multi-paires mise a jour

Un second backtest reprend les memes regles strictes et le meme moteur de production sur huit historiques Deriv apparies M1 bid/ask: EUR/USD, USD/JPY, GBP/USD, AUD/USD, USD/CAD, USD/CHF, NZD/USD et XAU/USD. Les bougies sont reechantillonnees en M5/M15. Sur le scenario de spread observe (1x), le resultat agrege est de 21 trades, 28,6 % gagnants, -0,318R par trade, PF 0,434 et 1 pli positif sur 5. XAU/USD seul reste a 6 trades, -0,444R par trade et PF 0,174. Les stress de spread 1,5x et 2x restent negatifs.

Le nombre de trades est faible et les dates de fin varient selon les historiques. Le R agregé n'est pas le rendement d'un compte: les transactions sur plusieurs paires peuvent se chevaucher et le calcul ne fixe pas une allocation de risque du portefeuille. Ce resultat ne valide donc pas des signaux SMC copiables. La console conserve SMC comme categorie distincte de recherche, affichee a cote de l'analyse Price Action par defaut, sans ordre copiable; le benchmark affiche maintenant le resultat multi-paires et le sous-resultat XAU/USD.

## Garde-fous de donnees et tests de non-regression

Avant d'evaluer un setup, le moteur bloque les OHLC invalides, les bougies sans horodatage, les doublons contradictoires, les sources non identifiees ou non alignees et une coupure dans les dernieres bougies. Les doublons identiques sont dedoublonnes et comptes. Les bougies encore ouvertes restent exclues. Un setup ou une zone en attente est remis a zero lors d'une coupure historique; les signaux de recherche sont aussi supprimes si l'historique est perime ou si les sources divergent.

Les tests unitaires SMC couvrent ces blocages, l'alignement multi-timeframe sans fuite de bougie future et l'absence d'ordre executable. Ils sont inclus dans `npm test`. Apres ces changements, les backtests fixes ne montrent aucune amelioration de performance: le resultat strict multi-paires reste negatif. Ces garde-fous fiabilisent le diagnostic, mais ne transforment pas la methode en strategie rentable validee.

## Fichiers principaux

- `smc-engine.mjs`: moteur SMC partage par le serveur et la variante stricte du backtest.
- `server.mjs`: recuperation et verification des historiques OHLC exacts, puis integration de la sortie dans la console.
- `analyse.html`, `assets/analyse-page.js`, `assets/oracle-extras.css`: choix du style et rendu du panneau.
- `scripts/backtest-kronos-smc-ablation-xauusd-2026.mjs`: simulation et generation du rapport.
- `data-backtest/2026-ytd-deriv/KRONOS_SMC_ABLATION_XAUUSD_2026_REPORT.md`: rapport detaille et resultat des plis.
- `scripts/backtest-kronos-smc-multipair-2026.mjs`: validation multi-paires avec le moteur SMC de production.
- `data-backtest/2026-ytd-deriv/KRONOS_SMC_MULTIPAIR_2026_REPORT.md`: couverture, couts, resultats par paire et plis chronologiques.
