# Oracle Forex mirror

Site miroir local de `heed-my-guide.lovable.app`, avec HTML SSR, CSS compilee et bundles JavaScript en local.

## Lancer

```sh
node server.mjs
```

Puis ouvrir:

```txt
http://127.0.0.1:4174/#signaux
```

## APIs

Variables attendues dans `secret.dev`:

```env
GROQ_KEY=...
GROQ_MODEL=llama-3.3-70b-versatile
TWELVE_DATA_API_KEY=...
FINNHUB_API_KEY=...
NEWS_API_KEY=...
DATABASE_URL=postgres://...
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STATE_TABLE=oracle_app_state
SUPABASE_TIMEOUT_MS=5000
ADMIN_TOKEN=une_phrase_secrete_longue
```

Le navigateur appelle seulement `/api/...`; les cles restent cote serveur local.

Table Supabase attendue pour la persistance serveur:

```sql
create table if not exists public.oracle_app_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
```

Le serveur accepte aussi les cles en rotation:

```env
GROQ_KEY_1=...
GROQ_KEY_2=...
TWELVE_DATA_API_KEY_1=...
TWELVE_DATA_API_KEY_2=...
ALPHA_VANTAGE_API_KEY_1=...
FINNHUB_API_KEY_1=...
MARKETAUX_API_KEY_1=...
EXCHANGERATE_API_KEY_1=...
```

Voir l'etat des rotations avec:

```txt
http://127.0.0.1:4174/api/provider-status
```

## Sauvegarde et restauration

L'etat serveur (comptes, historique d'apprentissage, cache marche) vit dans la table Postgres `oracle_app_state` (`DATABASE_URL`), avec un fallback local `data/*.json` si Postgres est injoignable. Ce fallback n'est jamais resynchronise vers Postgres une fois qu'il revient en ligne, et sur la plupart des hebergeurs le disque est ephemere entre deux deploiements — sans sauvegarde independante, une panne Postgres mal synchronisee avec un redeploiement peut faire perdre des donnees de facon definitive.

Sauvegarder (ecrit un fichier horodate dans `backups/`, ignore par git):

```sh
node scripts/backup.mjs
```

A planifier regulierement (cron systeme, Render Cron Job, GitHub Actions sur un schedule) et a copier hors de la machine qui heberge la base — une sauvegarde qui reste sur le meme disque que la base n'est pas une vraie sauvegarde.

Restaurer (dry-run par defaut, n'ecrit rien sans `--confirm`):

```sh
node scripts/restore.mjs --file backups/backup-2026-08-06T12-00-00-000Z.json
node scripts/restore.mjs --file backups/backup-2026-08-06T12-00-00-000Z.json --confirm
```

## Integration continue

`.github/workflows/ci.yml` verifie la syntaxe de `server.mjs` et de `scripts/*.mjs`, puis demarre le serveur sans aucune cle API configuree (le chemin degrade exact que traverse un depot fraichement clone ou une prod partiellement en panne) et interroge `/`, `/api/health`, `/api/signals` et `/api/analyze-chart` pour verifier qu'il repond sans planter.

## Acces premium manuel

Avant de connecter le paiement, vous pouvez donner Premium a des testeurs:

1. Ajoutez `ADMIN_TOKEN=...` dans `secret.dev` puis relancez `node server.mjs`.
2. Demandez au testeur de creer un compte sur `/signup`.
3. Ouvrez `/premium-admin`.
4. Entrez le token admin, l'email du compte et la duree en jours.

Les visiteurs anonymes et comptes free restent limites par quotas journaliers. Les comptes premium/admin sont illimites.

Quotas configurables:

```env
VISITOR_DAILY_ANALYSES=1
VISITOR_DAILY_CHAT=5
VISITOR_DAILY_DETECTIONS=2
FREE_DAILY_ANALYSES=3
FREE_DAILY_CHAT=25
FREE_DAILY_DETECTIONS=8
```
