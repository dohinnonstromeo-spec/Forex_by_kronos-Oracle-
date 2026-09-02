// Migrates the app's relational data from one Postgres database to another.
//
// Intended use:
//   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node scripts/migrate-postgres.mjs [--priority]
//
// Dry-run by default. Add --confirm to actually overwrite the target rows.
// With --confirm, the script snapshots the target into backups/ before writing.
// Use --priority to migrate only the core user/trading tables and cut the data volume.
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

function parseArgs(argv) {
  return {
    confirm: argv.includes("--confirm"),
    priority: argv.includes("--priority"),
  };
}

const TABLES = [
  "users",
  "sessions",
  "analyses",
  "push_subscriptions",
  "anonymous_usage",
  "user_usage",
  "rate_limit_attempts",
  "password_reset_tokens",
  "signal_alert_state",
  "trade_orders",
  "trade_prepare_claims",
  "auto_trade_leases",
  "trade_daily_usage",
  "scheduler_leases",
  "trade_operation_leases",
  "app_settings",
  "site_content",
  "auto_trading_accounts",
];

const PRIORITY_TABLES = [
  "users",
  "sessions",
  "analyses",
  "trade_orders",
  "auto_trading_accounts",
];

function redactUrl(url) {
  return String(url || "").replace(/:[^:@/]+@/, ":<redacted>@");
}

async function snapshotTable(pool, table) {
  const { rows } = await pool.query(`SELECT * FROM ${table}`);
  return rows;
}

async function snapshotTarget(pool, tables) {
  const snapshot = {
    createdAt: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) {
    try {
      snapshot.tables[table] = await snapshotTable(pool, table);
    } catch (error) {
      snapshot.tables[table] = { error: error.message };
    }
  }
  return snapshot;
}

async function ensureConnectivity(pool, name) {
  await pool.query("SELECT 1");
  console.log(`${name}: connexion OK`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv(join(root, "secret.dev"));
  const sourceUrl = process.env.SOURCE_DATABASE_URL || env.SOURCE_DATABASE_URL || "";
  const targetUrl = process.env.TARGET_DATABASE_URL || env.DATABASE_URL || "";
  const tables = args.priority ? PRIORITY_TABLES : TABLES;

  if (!sourceUrl || !targetUrl) {
    console.error("SOURCE_DATABASE_URL et TARGET_DATABASE_URL sont requis.");
    process.exit(1);
  }

  console.log(`Source: ${redactUrl(sourceUrl)}`);
  console.log(`Cible:  ${redactUrl(targetUrl)}`);
  console.log(`Mode: ${args.priority ? "priority" : "full"}`);
  console.log(`Tables: ${tables.join(", ")}`);

  const { Pool } = pg;
  const source = new Pool({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false } });
  const target = new Pool({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });

  try {
    await ensureConnectivity(source, "Source");
    await ensureConnectivity(target, "Cible");

    if (!args.confirm) {
      console.log("\nDRY-RUN -- aucune modification effectuée. Relance avec --confirm pour copier les données.");
      return;
    }

    const targetSnapshot = await snapshotTarget(target, tables);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(root, "backups");
    await mkdir(backupDir, { recursive: true });
    const backupPath = join(backupDir, `migration-backup-${stamp}.json`);
    await writeFile(backupPath, JSON.stringify(targetSnapshot, null, 2), "utf8");
    console.log(`Backup cible écrit: ${backupPath}`);

    await target.query("BEGIN");
    for (const table of tables) {
      const { rows } = await source.query(`SELECT * FROM ${table}`);
      await target.query(`DELETE FROM ${table}`);
      if (!rows.length) {
        console.log(`0 row(s): ${table}`);
        continue;
      }
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
      for (const row of rows) {
        await target.query(sql, columns.map((column) => row[column]));
      }
      console.log(`${rows.length} row(s): ${table}`);
    }
    await target.query("COMMIT");
    console.log("\nMigration terminée.");
  } catch (error) {
    try {
      await target.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Échec de la migration:", error.message);
  process.exit(1);
});