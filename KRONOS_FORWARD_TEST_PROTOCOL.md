# Protocole du forward test Price Action XAUUSD M5

## Objectif

Mesurer en temps réel, en mode recherche seulement, une configuration Price Action étroite déjà explorée sur l'historique Deriv/MT5. Le service ne crée pas d'ordre, n'écrit pas dans les analyses des utilisateurs et ne nourrit pas les statistiques de performance habituelles du site.

## Configuration figée

- Instrument : XAUUSD.
- Signal : cassure puis retest confirmé, bougie M5 clôturée.
- Sens : ventes uniquement.
- Entrée : première cotation bid valide au début de la bougie M5 suivante; la minute doit avoir commencé dans les cinq secondes suivant son ouverture.
- Stop : risque structurel calculé par le moteur Price Action, élargi à 1,5 fois; les objectifs sont recalculés depuis le prix d'entrée effectif.
- Sorties : 50 % à +1R, solde à +1,6R, ou clôture temporelle à 30 minutes.
- Coûts : spread bid/ask réellement observé, un tick de glissement défavorable par côté, aucune commission modélisée; rejet si le coût estimé dépasse 0,15R.
- Une seule position suivie à la fois. Pas de break-even dans cette variante.
- En cas de collision SL/TP dans une minute, le SL est retenu en premier.

Version du protocole : `xau-m5-pa-retest-short-sl150-tp1r-tp16r-bidask-v1`.

Ce candidat a été choisi après comparaison des variantes sur l'historique déjà examiné. Le forward test apporte de nouvelles observations, mais ce biais de sélection historique reste une limite; il ne transforme pas le résultat passé en preuve d'un edge.

## Données et qualité

Le serveur s'abonne au flux public Deriv et enregistre les OHLC bid/ask M1 construits à partir des ticks. Une minute n'est utilisable que si elle contient au moins dix ticks, si le premier arrive dans les cinq secondes suivant le début et si le dernier arrive dans les six dernières secondes. Une M5 n'est évaluée que si ses cinq minutes sont utilisables.

L'analyse des setups utilise les bougies M5 Deriv clôturées. Le suivi démarre au lancement du service : il reconstruit seulement l'état du setup sur l'historique récent pour éviter de créer des trades rétrospectifs sans ticks capturés. Si le scanner manque des clôtures M5, il les compte comme manquées et reprend sur la bougie la plus récente; il ne fabrique pas d'entrées dans le passé.

Une minute manquante pendant une position classe le cas `DATA_GAP`, censuré et exclu des statistiques des trades clos. Une entrée sans cotation de qualité après deux minutes est classée comme manquée. Les minute OHLC ne conservent pas l'ordre des mouvements à l'intérieur d'une minute; le choix SL d'abord rend ce cas conservateur.

## Consultation et arrêt

Un administrateur peut consulter le journal dans **Administration → Forward test Price Action XAUUSD M5** ou via `GET /api/admin/research/pa-forward`. Le serveur expose les compteurs de statuts, le résultat en R, le drawdown, les bougies M5 ignorées et les derniers trades capturés.

Le suivi est activé par défaut. Pour le désactiver, définir `KRONOS_PA_FORWARD_TEST_ENABLED=false`. La fréquence de lecture M5 est configurable avec `KRONOS_PA_FORWARD_SCAN_INTERVAL_SECONDS` (15 à 300 secondes, 30 par défaut).

## Lecture des résultats

Le panneau attend 100 trades clos et 20 semaines UTC actives avant d'étiqueter le résultat comme négatif, non concluant ou piste positive. L'intervalle à 95 % est un bootstrap déterministe de 5 000 rééchantillonnages de semaines actives; il décrit l'incertitude de l'échantillon, pas une probabilité future. Une piste positive reste à répliquer sur une période indépendante, car le candidat a été choisi après examen de l'historique.

Le win rate affiché est descriptif, pas une probabilité prédictive. Les résultats prospectifs ne sont pas directement comparables à l'historique MT5 : le flux public Deriv peut différer du flux et des règles d'exécution du compte, et le regroupement des ticks en M1 perd leur ordre intraminute. Ne modifier aucun paramètre de cette version pendant sa collecte; toute variante doit recevoir un nouvel identifiant de version et un journal séparé.
