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

## APIs a brancher plus tard

Variables attendues dans `secret.dev`:

```env
GROQ_KEY=...
GROQ_MODEL=llama3-70b-8192
TWELVE_DATA_API_KEY=...
FINNHUB_API_KEY=...
NEWS_API_KEY=...
```

Le navigateur appelle seulement `/api/...`; les cles restent cote serveur local.
