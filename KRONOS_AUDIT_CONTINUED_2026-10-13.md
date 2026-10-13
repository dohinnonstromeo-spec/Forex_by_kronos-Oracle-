# Kronos — suite de l'audit et des tests, 13 octobre 2026

## Ce que j'ai teste

Depuis le rapport initial, j'ai ajoute des variantes de recherche au backtest Price Action Deriv et compare, sur XAUUSD M5, le retest avec stop x1.5 a quatre hypotheses : session UTC, alignement M15, shorts seuls, et shorts seulement lorsque le M15 est baissier. J'ai ensuite compare les signaux shorts/longs sur les huit marches en M5.

Donnees Deriv MT5 Demo : du 1 janvier au 8 octobre 2026. Entree a l'ouverture suivante, sorties simulees sur OHLC, spread historique et slippage explicite de 1 tick par cote. Le compte, les commissions exactes et les couts du serveur live ne sont pas confirmes.

## Resultats qui meritent une suite

Sur XAUUSD M5, le retest stop x1.5 sans filtre directionnel donne 718 trades, +0,031R/trade, PF 1,074 et 5 plis positifs sur 5. En revalorisant les memes trades avec le spread double, l'esperance tombe a +0,006R/trade : la marge est presque entierement absorbee par les couts.

En ne gardant que les ventes, le resultat historique monte a 368 trades, +0,098R/trade, PF 1,254 et 4 plis positifs sur 5; au spread double, +0,074R/trade. C'est la meilleure piste observee dans cette recherche, pas une strategie validee. La selection de cette hypothese a eu lieu apres inspection du meme historique; ses plis tardifs ne sont donc pas un holdout independant.

Le filtre combine « ventes + EMA20/EMA50 M15 baissieres » est moins bon : 215 trades, +0,054R/trade et +0,032R au spread double. Il reduit le nombre de trades sans confirmer que le filtre ameliore le resultat.

Le controle intermarche rejette une regle « vendre seulement » generale : plusieurs paires restent negatives, et quelques exceptions ont des echantillons plus petits. XAUUSD se distingue nettement; il faut verifier si cela vient d'une structure exploitable ou du regime de 2026.

## Contrainte du petit solde

La specification Deriv publique indique pour XAUUSD un contrat de 100 oz par lot et un volume minimal de 0,01 lot ([specifications Deriv](https://ae.deriv.com/trading-specifications)). Sous cette specification, 0,01 lot correspond a environ 1 oz : un stop de 1 USD/oz risque environ 1 USD avant couts.

Dans les trades XAU M5 retest x1.5, le 90e percentile de perte estimee au volume minimal est d'environ 17,34 USD au spread observe et 17,60 USD au spread double. Pour rester a 0,5% de risque sur ce percentile, il faudrait un solde d'environ 3 468 a 3 520 USD. A 1 000 USD, le risque correspondant est environ 1,73 a 1,76% par trade; a 100 USD, environ 17 a 18%. Ces estimations n'incluent pas un gap ou un glissement exceptionnel et doivent etre recalculees avec la specification de ton serveur Deriv.

Le code du site a deja un garde-fou de taille minimale et un profil precision qui refuse un trade si le lot minimum depasse le budget. Le mode scalp du profil precision est aussi bloque parce que le moteur scalp actuel n'a pas passe sa validation petit capital. Ce comportement doit rester actif tant qu'un moteur scalp valide n'est pas trouve.

## Ce que cela change pour le site

- Sans capture, avec Price Action + scalping, les modes rapide et profond passent tous deux par le moteur OHLC déterministe partagé. Il expose les niveaux candidats dans le panneau de recherche, mais les rend non exécutables; la réponse narrative IA n'est donc pas le moteur de cette combinaison.
- Le backtest des sorties appelle maintenant exactement la même fonction d'entrée que le panneau du site (`kronos-pa-break-retest-v1`). Une comparaison avant/après sur XAUUSD M5 a retrouvé les mêmes résultats pour les 17 variantes, les trois niveaux de spread et chacun des cinq plis.
- La meilleure hypothese XAU n'est pas encore un signal executable : le backtest applique stop x1.5 et des TP recalcules a +1R/+1,6R; le panneau actuel expose un candidat de recherche avec stop structurel de base et sans preuve de cette gestion.
- Le chemin rapide et sans capture doit continuer a s'abstenir quand les bougies Deriv exactes, recentes et alignees ne sont pas disponibles. Plus de signaux ne corrige pas un edge negatif.
- Ne pas afficher le rendement historique comme probabilite de gain, et ne pas activer les ventes seules en production sur ce seul test.
- Ajouter une nouvelle comparaison seulement si elle formule une hypothese avant de regarder la periode d'evaluation; conserver un bloc de dates futur intact, puis faire un forward test papier.

## Prochaine validation necessaire

L'historique MT5 local s'arrete au 8 octobre 2026. Une extension du meme export Deriv est necessaire pour verifier le comportement apres cette date. Le script de telechargement existant depend du paquet Python MetaTrader5, qui n'est pas installe dans l'environnement utilise pendant cette recherche. Aucune donnee de courtier live n'a donc ete ajoutee et aucune strategie n'a ete activee dans le site.

Rapports detailles :

- [Filtres XAUUSD M5 et stop/TP](data-backtest/2026-ytd-deriv/KRONOS_EXIT_MANAGEMENT_DERIV_YTD_2026_XAU-M5-SHORT-M15_REPORT.md)
- [Controle directionnel intermarche M5](data-backtest/2026-ytd-deriv/KRONOS_EXIT_MANAGEMENT_DERIV_YTD_2026_M5-DIRECTION-CONTROL_REPORT.md)
- [Parite moteur partagé avant/après](data-backtest/2026-ytd-deriv/KRONOS_EXIT_MANAGEMENT_DERIV_YTD_2026_ENGINE-PARITY_REPORT.md)

## Mise a jour : execution M1 BID/ASK reconstruite

J'ai ajoute un mode experimental au backtest : les signaux restent calcules sur M5 ou M15, mais les entrees, stops et objectifs sont suivis minute par minute. Un achat entre sur ASK et sort sur BID; une vente entre sur BID et sort sur ASK. Si stop et objectif sont tous deux touches pendant la meme minute, le stop est compte en premier. Le mode OHLC historique reste disponible et n'est pas remplace.

Les ASK ne viennent pas d'un historique de ticks natif : ils sont reconstruits en ajoutant le spread MT5 de la minute aux OHLC BID. Le spread x1.5/x2 revalorise les transactions du scenario de base, sans rejouer leur chemin. Ces chiffres sont donc une simulation d'execution plus detaillee, pas une reconstitution exacte des fills Deriv.

### Ce que le nouveau passage change

- XAUUSD M5, retest avec stop x1.5 : 720 trades, +0,053R/trade, PF 1,140, plis positifs 5/5; +0,030R/trade sous spread x2. Le resultat est meilleur que l'ancien passage M5 OHLC (+0,031R et +0,006R sous spread x2), mais l'ecart n'en fait pas une garantie de rendement.
- XAUUSD M5, retest x1.5 et ventes seulement : 370 trades, +0,095R/trade, PF 1,261, plis positifs 5/5; +0,072R/trade sous spread x2. Les plis donnent +0,189, +0,022, +0,126, +0,046 et +0,117R/trade. Le deuxieme pli est presque neutre : le resultat ne progresse pas regulierement.
- Ajouter l'alignement EMA20/EMA50 M15 au filtre short reduit l'echantillon a 215 trades et rend le resultat instable : +0,046R global, mais -0,037 et -0,158R sur les plis 3 et 4. Je ne retiens donc pas ce filtre.
- Sur XAUUSD M15, les retests restent negatifs (-0,038R sans stop elargi, -0,044R avec x1.5). Le setup de rejet M15 est legerement positif (+0,009R) mais tombe a -0,010R au spread x2 et change fortement selon les plis. La piste ressort donc en M5, pas en M15.
- Le controle sur huit marches ne confirme pas la regle shorts-only comme recette generale. XAUUSD est positif sur 5/5 plis; AUDUSD ressort a +0,076R sur 124 trades mais seulement 3/5 plis; plusieurs autres paires sont negatives. Toute regle doit rester propre a la paire tant qu'elle n'a pas passe d'autres periodes.
- Un bootstrap par semaines UTC entieres (5 000 repetitions) estime pour XAUUSD short-only un intervalle 95% de [+0,018; +0,171]R au spread observe, mais [-0,005; +0,150]R au spread x2. AUDUSD a des intervalles beaucoup plus larges qui traversent zero. Ces intervalles ne corrigent pas le fait que la variante a ete selectionnee apres inspection de l'historique; ils ne valident donc pas un edge futur.

### Petit solde et decision

Avec l'hypothese publique de 0,01 lot XAUUSD equivalent a environ 1 oz, la perte au stop du lot minimum estimee au 90e percentile est de 17,04 USD pour la variante short-only (17,26 USD au spread x2). Cela correspond a un solde theorique d'environ 3 409 USD pour plafonner ce percentile a 0,5% du compte; autour de 1 000 USD, le risque au lot minimum serait deja d'environ 1,7% sur ce percentile. Verifie la taille de contrat et le volume minimum du symbole sur ton propre serveur Deriv : ce calcul ne prend pas en compte la marge, les gaps ni les glissements extremes.

Conclusion de recherche : le meilleur candidat actuel est XAUUSD M5, retest, stop x1.5, ventes seulement, mais je ne l'active pas sur le site. La famille de filtres a ete choisie apres inspection de ce meme historique; les cinq plis ne constituent pas un echantillon vierge. Le site doit continuer a montrer des niveaux comme candidats non executables et ne doit pas afficher ces resultats comme probabilite de gain. La prochaine preuve utile est un forward test papier, avec la logique et les parametres figes, sur de nouvelles donnees Deriv.

Rapports experimentaux :

- [XAUUSD M5/M15, exits suivis en M1](data-backtest/2026-ytd-deriv/KRONOS_EXIT_MANAGEMENT_DERIV_YTD_2026_M1-QUOTES-SCALPING_REPORT.md)
- [Comparaison M5 sur huit marches, exits suivis en M1](data-backtest/2026-ytd-deriv/KRONOS_EXIT_MANAGEMENT_DERIV_YTD_2026_M1-QUOTES-MULTIPAIR_REPORT.md)

## Suite : suivi prospectif isole

Un forward test papier a ete ajoute pour figer le candidat XAUUSD M5 short-only et mesurer ses fills sur des cotations bid/ask captees apres le demarrage du serveur. Il est distinct des analyses utilisateur, de la calibration et du trading automatique. Le détail reproductible est dans [le protocole du forward test](KRONOS_FORWARD_TEST_PROTOCOL.md).

Le service exige cinq minutes M1 de ticks suffisamment couvrantes pour accepter une bougie M5; les minutes partielles, les entrees sans cotation fiable et les trades traversant une coupure sont rejetees ou censurees. Le panneau admin expose l'etat du flux, les compteurs de qualite et les resultats descriptifs. La logique a passe une verification syntaxique et des scenarios synthétiques signal, entrée, TP1/TP2, collision SL/TP et manque de donnees. Le collecteur n'a pas encore tourne en production : il n'y a donc pas de resultat prospectif a annoncer.