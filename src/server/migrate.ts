import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./lib/crypto";
import { exec, rows, type Db } from "./lib/db";

export function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "../schema/migrations"), path.join(here, "../../schema/migrations"), path.join(process.cwd(), "schema/migrations")];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error("schema/migrations directory not found");
  return found;
}

/** Splits a migration into statements: one per line ending in ";", comment lines dropped. */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate(db: Db, dir = migrationsDir(), log: (msg: string) => void = console.log): Promise<string[]> {
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version VARCHAR(128) NOT NULL PRIMARY KEY,
       checksum CHAR(64) NOT NULL,
       applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
     ) ENGINE=InnoDB`,
  );
  const applied = new Map((await rows<{ version: string; checksum: string }>(db, "SELECT version, checksum FROM schema_migrations")).map((r) => [r.version, r.checksum]));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    const checksum = sha256(sql);
    const known = applied.get(file);
    if (known) {
      if (known !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
      continue;
    }
    log(`Applying ${file}`);
    for (const statement of splitStatements(sql)) await db.query(statement);
    await exec(db, "INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)", [file, checksum]);
    ran.push(file);
  }
  return ran;
}
