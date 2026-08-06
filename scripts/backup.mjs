// Dumps every row of the Postgres state table (oracle_app_state by default --
// auth-store, learning-log, market-cache all live there as JSONB documents,
// see ensureStateTable() in server.mjs) to a single timestamped JSON file.
//
// Why this exists: server.mjs falls back to local JSON files in data/ when
// Postgres is briefly unreachable, but never syncs those writes back once
// Postgres recovers -- and on most hosting platforms the filesystem is
// ephemeral across deploys. Without an independent backup, a Postgres outage
// timed badly with a redeploy can permanently lose auth/learning data.
//
// Usage: node scripts/backup.mjs
// Schedule it (Render Cron Job, system cron, GitHub Actions on a schedule --
// see README) and copy BACKUP_DIR off-host; a backup that only lives on the
// same disk as the database is not a real backup.
import { readFile, mkdir, writeFile } from "node:fs/promises";
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

async function main() {
  const env = await loadEnv(join(root, "secret.dev"));
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL manquant (secret.dev ou variable d'environnement) -- rien à sauvegarder.");
    process.exit(1);
  }
  const table = env.SUPABASE_STATE_TABLE || "oracle_app_state";
  const outDir = env.BACKUP_DIR || join(root, "backups");
  await mkdir(outDir, { recursive: true });

  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query(`SELECT id, payload, updated_at FROM ${table} ORDER BY id`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(outDir, `backup-${stamp}.json`);
    const dump = {
      createdAt: new Date().toISOString(),
      table,
      documentCount: rows.length,
      documents: rows,
    };
    await writeFile(file, JSON.stringify(dump, null, 2), "utf8");
    console.log(`Sauvegarde écrite: ${file}`);
    console.log(`${rows.length} document(s): ${rows.map((r) => r.id).join(", ") || "(table vide)"}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Échec de la sauvegarde:", error.message);
  process.exit(1);
});
