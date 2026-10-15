import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { SUPER_ADMIN_SLUG } from "@shared/permissions";
import { auditStandalone, verifyAuditChain } from "../server/lib/audit";
import { createDb, exec, one } from "../server/lib/db";
import { hashPassword } from "../server/lib/passwords";
import { migrate } from "../server/migrate";
import { seedRoles } from "../server/seed";
import { temporaryPassword } from "../server/staff/guards";

const HELP = `BIS Markets CRM command line

  generate-key                       Print a new random CRM_DATA_KEY
  migrate                            Apply new database migrations
  seed-roles [--reset]               Create the built-in roles (--reset restores their default permissions)
  create-super-admin --email E --name N
                                     Create a Super Admin and print a one-time temporary password
  verify-audit                       Check the audit log hash chain

Commands other than generate-key read CRM_DATABASE_URL from the environment.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }
  if (command === "generate-key") {
    console.log(randomBytes(32).toString("base64"));
    return;
  }
  const url = process.env.CRM_DATABASE_URL;
  if (!url) throw new Error("Set CRM_DATABASE_URL first.");
  const db = createDb(url);
  try {
    switch (command) {
      case "migrate": {
        const ran = await migrate(db);
        console.log(ran.length ? `Applied ${ran.length} migration(s).` : "Database is up to date.");
        break;
      }
      case "seed-roles": {
        const { values } = parseArgs({ args: rest, options: { reset: { type: "boolean", default: false } } });
        const result = await seedRoles(db, values.reset);
        console.log(`Created: ${result.created.join(", ") || "none"}. Reset: ${result.reset.join(", ") || "none"}.`);
        break;
      }
      case "create-super-admin": {
        const { values } = parseArgs({ args: rest, options: { email: { type: "string" }, name: { type: "string" } } });
        const email = values.email?.trim().toLowerCase();
        const name = values.name?.trim();
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) throw new Error("Pass --email and --name.");
        const role = await one<{ id: number }>(db, "SELECT id FROM roles WHERE slug = ?", [SUPER_ADMIN_SLUG]);
        if (!role) throw new Error("Run seed-roles first.");
        if (await one(db, "SELECT id FROM staff_users WHERE email = ?", [email])) throw new Error("A staff account with this email already exists.");
        const password = temporaryPassword();
        const result = await exec(db, "INSERT INTO staff_users (email, name, password_hash, role_id, must_change_password) VALUES (?, ?, ?, ?, 1)", [
          email,
          name,
          await hashPassword(password),
          role.id,
        ]);
        await auditStandalone(db, { actor: { type: "system", id: null, label: "cli" }, ip: "", userAgent: "cli" }, {
          action: "staff.created", entityType: "staff", entityId: result.insertId, after: { email, name, role: SUPER_ADMIN_SLUG },
        });
        console.log(`Super Admin ${email} created.`);
        console.log(`Temporary password (shown once): ${password}`);
        console.log("At first sign-in they must set a new password and set up 2FA.");
        break;
      }
      case "verify-audit": {
        const report = await verifyAuditChain(db);
        console.log(report.ok ? `Audit log intact: ${report.checked} entries checked.` : `AUDIT LOG BROKEN at entry ${report.brokenAtId}: ${report.reason}`);
        if (!report.ok) process.exitCode = 2;
        break;
      }
      default:
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
