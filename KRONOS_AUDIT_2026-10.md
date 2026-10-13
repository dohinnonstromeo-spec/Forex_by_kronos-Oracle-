# Audit Kronos — 13 octobre 2026

## Avis

Kronos est déjà une console d'analyse assez complète, avec des garde-fous utiles sur la fraîcheur des prix, la qualité des données, les niveaux incohérents et l'absence de setup. Le code distingue aussi le score interne d'une probabilité de gain. En revanche, le site n'est pas encore un moteur de trading dont l'avantage statistique est établi : ses chemins d'analyse ne correspondent pas tous aux stratégies qui ont été backtestées.

## Ce que le site fait réellement

- Le graphique TradingView intégré est une vue. Le moteur n'en lit pas les pixels ni les données internes; il reçoit ses cours et bougies OHLC de fournisseurs API. Une capture téléversée suit un chemin séparé d'analyse visuelle.
- Sans capture, si le style est Price Action et la stratégie Scalping, les modes rapide et profond appellent le moteur OHLC déterministe partagé. Il affiche les candidats et leurs niveaux à titre de recherche, mais les marque « non exécutables »; les autres chemins d'analyse peuvent encore utiliser une réponse IA et ne sont pas ce backtest.
- Le mode SMC est un diagnostic déterministe séparé, basé sur des bougies clôturées et du contexte MTF. Il ne donne pas de trade copiable. Minimum moteur : 45 bougies de setup et 55 bougies de contexte.
- Les autres styles disponibles ne constituent pas huit moteurs mécaniques dont l'avantage aurait été prouvé. Une partie de leur lecture dépend du modèle IA et de validations textuelles.
- Le plan de niveaux copié par l'utilisateur n'est pas une exécution chez Deriv. Le spread, les commissions et le slippage réels peuvent différer.

## Ce que disent les tests présents

### Price Action

Le rapport Deriv 2026 teste 8 marchés, M1/M5/M15, avec spread observé. Sur 144 combinaisons annoncées, 8 seulement ont un R moyen positif au coût observé. Parmi les 111 combinaisons ayant au moins 100 trades, deux sont positives au coût observé et aucune ne reste positive au spread doublé. C'est un signal d'alerte sur les règles mécaniques testées, pas une preuve que toute lecture discrétionnaire du Price Action perd.

### Pine R2 XAUUSD

Le test disponible donne 33 trades, +0,166R moyen, PF 1,84 et 4 plis chronologiques positifs sur 5; à spread doublé, +0,156R moyen. C'est encourageant comme hypothèse de recherche, mais trop peu de trades, un seul marché, des hypothèses de coût incomplètes et une simulation locale. Surtout, ce moteur sweep → déplacement/BOS → FVG → retest n'est pas le chemin qui produit l'analyse Price Action de la console.

### SMC

Le rapport strict multi-paires indique 21 trades, -0,318R/trade, PF 0,434 et 1 pli positif sur 5. Pour XAUUSD seul : 6 trades, -0,444R/trade, PF 0,174. La décision correcte est de garder SMC en recherche et sans signal copiable, comme c'est le cas actuellement.

## Corrections faites dans cette révision

- Le graphique TradingView de la console reste maintenant synchronisé avec la paire du formulaire. La note précise qu'il s'agit d'une vue et que son fournisseur peut différer des OHLC analysés.
- Sans résultats confirmés pour le style et le contexte, le score ne reçoit plus de bonus/malus à partir du taux historique d'un autre moteur sur la même paire. Une statistique XAU d'une stratégie distincte ne doit pas étalonner le score d'une analyse IA.
- Le moteur Price Action utilisé par la console et le test des sorties appelle maintenant la même fonction déterministe. Sur XAUUSD M5, les 17 variantes et leurs cinq plis restent identiques à l'ancien calcul, jusque dans les résumés par niveau de spread.

## Priorités avant de parler de performance

1. Construire une règle Price Action OHLC explicite pour le chemin sans capture : déclencheur, invalidation, entrée, sorties, durée maximale et conditions d'abstention. Le mode rapide doit appliquer la même règle.
2. Backtester exactement cette version de production sur la même source que l'utilisateur, avec spread bid/ask, commissions, slippage, cas ambigus intrabar et règles de taille de position.
3. Garder une période chronologique entièrement hors réglage; exiger plusieurs plis stables, puis un forward test papier avant d'afficher des signaux comme validés.
4. Comparer séparément M1/M5/M15, les paires, les sessions et les profils prudent/étendu. Ne pas choisir un réglage gagnant sur quelques trades.
5. Afficher le nombre de trades, l'espérance nette, le PF, le drawdown et la couverture des coûts. Ne pas transformer le score de cohérence en pourcentage de chance.

**Conclusion :** bonne base de console éducative et de recherche, pas encore preuve d'une rentabilité durable. La priorité n'est pas d'ajouter plus de vocabulaire SMC/ICT; c'est d'aligner une seule règle testée, les données affichées et le moteur qui produit les niveaux.
