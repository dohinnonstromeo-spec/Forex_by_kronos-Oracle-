"""
Téléchargeur de données historiques M1 (minute) pour Kronos / Oracle Forex
Source : Dukascopy Bank SA (gratuit, sans clé API)

Installation (à faire une seule fois, en local, dans le venv) :
    pip install dukascopy-python pandas

Utilisation :
    python download_dukascopy_data.py [jours]

    jours (optionnel) : nombre de jours d'historique à télécharger, 90 par défaut.
    Le script d'origine visait 365 jours -- réduit par défaut pour un premier
    passage plus rapide (télécharger + convertir des ticks Dukascopy en M1 sur un
    an, x4 instruments, prend un moment). Relance avec un nombre plus grand une
    fois le pipeline confirmé si un échantillon plus long est utile.

Les fichiers CSV sont créés dans un dossier "data-backtest/" à côté de ce script,
un fichier par instrument (ex: XAUUSD_M1.csv, EURUSD_M1.csv).
"""

import os
import sys
from datetime import datetime, timedelta

import dukascopy_python
from dukascopy_python.instruments import (
    INSTRUMENT_FX_MAJORS_EUR_USD,
    INSTRUMENT_FX_MAJORS_GBP_USD,
    INSTRUMENT_FX_MAJORS_USD_JPY,
    INSTRUMENT_FX_METALS_XAU_USD,
)

INSTRUMENTS = {
    "XAUUSD": INSTRUMENT_FX_METALS_XAU_USD,
    "EURUSD": INSTRUMENT_FX_MAJORS_EUR_USD,
    "GBPUSD": INSTRUMENT_FX_MAJORS_GBP_USD,
    "USDJPY": INSTRUMENT_FX_MAJORS_USD_JPY,
}

DAYS_BACK = int(sys.argv[1]) if len(sys.argv) > 1 else 90
DATE_FIN = datetime.now()
DATE_DEBUT = DATE_FIN - timedelta(days=DAYS_BACK)

TIMEFRAME = dukascopy_python.INTERVAL_MIN_1
PRIX = dukascopy_python.OFFER_SIDE_BID

DOSSIER_SORTIE = os.path.join(os.path.dirname(__file__), "..", "data-backtest")


def telecharger(nom: str, instrument: str) -> None:
    print(f"[{nom}] Telechargement en cours ({DATE_DEBUT.date()} -> {DATE_FIN.date()})...")
    try:
        df = dukascopy_python.fetch(
            instrument,
            TIMEFRAME,
            PRIX,
            DATE_DEBUT,
            DATE_FIN,
        )
    except Exception as e:
        print(f"[{nom}] ECHEC : {e}")
        return

    if df is None or df.empty:
        print(f"[{nom}] Aucune donnee recue.")
        return

    os.makedirs(DOSSIER_SORTIE, exist_ok=True)
    chemin = os.path.join(DOSSIER_SORTIE, f"{nom}_M1.csv")
    df.to_csv(chemin)
    print(f"[{nom}] OK -- {len(df)} lignes sauvegardees dans {chemin}")


def main():
    print(f"Telechargement de {len(INSTRUMENTS)} instrument(s) en M1 sur {DAYS_BACK} jours...\n")
    for nom, instrument in INSTRUMENTS.items():
        telecharger(nom, instrument)
    print("\nTermine. Verifie le dossier 'data-backtest/'.")


if __name__ == "__main__":
    main()
