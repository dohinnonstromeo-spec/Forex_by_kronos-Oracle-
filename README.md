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
GROQ_VISION_MODEL=qwen/qwen3.6-27b
TWELVE_DATA_API_KEY=...
FINNHUB_API_KEY=...
NEWS_API_KEY=...
DATABASE_URL=postgres://...
DATABASE_SSL_REJECT_UNAUTHORIZED=false  # developpement uniquement; ignore en production
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STATE_TABLE=oracle_app_state
SUPABASE_TIMEOUT_MS=5000
ADMIN_TOKEN=une_phrase_secrete_longue
PUBLIC_ORIGIN=https://forex-by-kronos-oracle.onrender.com
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
RESEND_FROM=Oracle Forex <noreply@domaine-verifie.example>
BROKER_CREDENTIALS_ENCRYPTION_KEY=genere_un_secret_aleatoire_d_au_moins_32_caracteres
BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS=ancienne_cle_pendant_une_rotation
BROKER_CREDENTIALS_ENCRYPTION_REQUIRED=true
VAPID_PUBLIC_KEY=cle_publique_web_push
VAPID_PRIVATE_KEY=cle_privee_web_push
VAPID_SUBJECT=mailto:adresse-de-contact@domaine.example
```

Le navigateur appelle seulement `/api/...`; les clés restent côté serveur local.

Les jetons MetaApi des utilisateurs sont chiffrés au repos avec AES-256-GCM lorsque BROKER_CREDENTIALS_ENCRYPTION_KEY est configurée. En production, le mode obligatoire est actif par défaut : sans cette clé, une nouvelle connexion broker est refusée plutôt que d'enregistrer un secret en clair. Les anciennes valeurs sont relues pour assurer la migration puis rechiffrées automatiquement. Conserver cette clé dans le gestionnaire de secrets de l'hébergeur et hors du dépôt. Pendant une rotation, renseigner la nouvelle clé dans BROKER_CREDENTIALS_ENCRYPTION_KEY et l'ancienne dans BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS. Le serveur relit puis rechiffre automatiquement les valeurs encore protégées par l'ancienne clé. Après vérification, retirer la variable PREVIOUS. Conserver ces clés dans le gestionnaire de secrets de l'hébergeur et hors du dépôt.

## Configuration Render et vérification

Dans Render, renseigner ces variables dans l'environnement du service web, sans les committer dans Git :

- `DATABASE_URL` : URL de la base Neon active.
- `BROKER_CREDENTIALS_ENCRYPTION_KEY` : secret aléatoire d'au moins 32 caractères. Sans lui, les nouvelles connexions broker sont bloquées en production.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` : nécessaires pour activer les notifications push mobiles. La clé privée reste uniquement côté serveur.

Après chaque remplacement de base ou modification d'environnement :

1. Attendre que `/api/ready` réponde avec `ok: true`.
2. Ouvrir le centre d'état du tableau de bord et vérifier Neon, le broker et le robot.
3. Autoriser les notifications dans le navigateur, puis utiliser `Tester sur cet appareil`.
4. Vérifier le compte broker en mode démo avant toute activation réelle.

Le centre d'état affiche le dernier motif connu du robot et la prochaine vérification. Ce diagnostic en mémoire est volontairement sans écriture à chaque cycle afin de ne pas consommer inutilement le quota Neon ; il repart de zéro après un redémarrage et indique alors clairement qu'aucun cycle n'a encore été observé.

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

Voir l'état des rotations avec :

```txt
http://127.0.0.1:4174/api/provider-status
```

## Sauvegarde et restauration

L'état serveur (comptes, historique d'apprentissage, cache marché) vit dans la table Postgres `oracle_app_state` (`DATABASE_URL`), avec un fallback local `data/*.json` si Postgres est injoignable. Ce fallback n'est jamais resynchronisé vers Postgres une fois qu'il revient en ligne, et sur la plupart des hébergeurs le disque est éphémère entre deux déploiements - sans sauvegarde indépendante, une panne Postgres mal synchronisée avec un redéploiement peut faire perdre des données de façon définitive.

Sauvegarder (écrit un fichier horodaté dans `backups/`, ignoré par git) :

```sh
node scripts/backup.mjs
```

À planifier régulièrement (cron système, Render Cron Job, GitHub Actions sur un schedule) et à copier hors de la machine qui héberge la base - une sauvegarde qui reste sur le même disque que la base n'est pas une vraie sauvegarde.

Restaurer (dry-run par defaut, n'ecrit rien sans `--confirm`):

```sh
node scripts/restore.mjs --file backups/backup-2026-08-06T12-00-00-000Z.json
node scripts/restore.mjs --file backups/backup-2026-08-06T12-00-00-000Z.json --confirm
```

## Integration continue

`.github/workflows/ci.yml` vérifie la syntaxe de `server.mjs` et de `scripts/*.mjs`, puis démarre le serveur sans aucune clé API configurée (le chemin dégradé exact que traverse un dépôt fraîchement cloné ou une production partiellement en panne) et interroge `/`, `/api/health`, `/api/signals` et `/api/analyze-chart` pour vérifier qu'il répond sans planter.

## Acces premium manuel

Avant de connecter le paiement, vous pouvez donner Premium à des testeurs :

1. Ajoutez `ADMIN_TOKEN=...` dans `secret.dev` puis relancez `node server.mjs`.
2. Demandez au testeur de creer un compte sur `/signup`.
3. Ouvrez `/premium-admin`.
4. Entrez le token admin, l'email du compte et la durée en jours.

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
