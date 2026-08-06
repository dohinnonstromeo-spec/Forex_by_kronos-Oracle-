// Restores a backup produced by scripts/backup.mjs into the Postgres state table.
//
// Dry-run by default: reading and printing what a backup contains never needs
// database credentials. Nothing is written until you pass --confirm, and only
// --confirm requires DATABASE_URL -- this is the last line of defense before a
// disaster-recovery restore overwrites live data, so it doesn't run quietly.
//
// Usage:
//   node scripts/restore.mjs --file backups/backup-2026-08-06T12-00-00-000Z.json
//   node scripts/restore.mjs --file backups/backup-....json --confirm
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadEnv(path) {
  const out = {};
  if (!existsSync(path)) return { ...process.env };
  const raw = await readFile(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { ...out, ...process.env };
}

function parseArgs(argv) {
  const args = { confirm: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--confirm") args.confirm = true;
    else if (argv[i] === "--file") args.file = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("Usage: node scripts/restore.mjs --file <backup.json> [--confirm]");
    process.exit(1);
  }
  if (!existsSync(args.file)) {
    console.error(`Fichier introuvable: ${args.file}`);
    process.exit(1);
  }

  const dump = JSON.parse(await readFile(args.file, "utf8"));
  if (!Array.isArray(dump.documents)) {
    console.error("Fichier de sauvegarde invalide: pas de champ 'documents'.");
    process.exit(1);
  }

  console.log(`Sauvegarde du ${dump.createdAt || "(date inconnue)"}`);
  console.log(`Table cible: ${dump.table || "oracle_app_state"}`);
  console.log(`${dump.documents.length} document(s): ${dump.documents.map((d) => `${d.id} (${JSON.stringify(d.payload).length} octets)`).join(", ") || "(vide)"}`);

  if (!args.confirm) {
    console.log("\nDRY-RUN -- aucune modification effectuée. Relance avec --confirm pour écrire dans la base.");
    return;
  }

  const env = await loadEnv(join(root, "secret.dev"));
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL manquant -- impossible de restaurer avec --confirm.");
    process.exit(1);
  }
  const table = env.SUPABASE_STATE_TABLE || dump.table || "oracle_app_state";

  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, payload jsonb, updated_at timestamptz DEFAULT now())`);
    for (const doc of dump.documents) {
      await pool.query(
        `INSERT INTO ${table} (id, payload, updated_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [doc.id, JSON.stringify(doc.payload), doc.updated_at || new Date().toISOString()],
      );
      console.log(`  restauré: ${doc.id}`);
    }
    console.log(`\nRestauration terminée: ${dump.documents.length} document(s) écrits dans ${table}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Échec de la restauration:", error.message);
  process.exit(1);
});
