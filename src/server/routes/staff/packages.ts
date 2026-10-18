import { Router, type Request } from "express";
import { z } from "zod";
import { NOT_PLAIN } from "@shared/money";
import { MT5_GROUP, SERVER_CODE } from "../../../gateway/protocol";
import type { AppDeps } from "../../app";
import { auditContext, writeAudit } from "../../lib/audit";
import { exec, one, rows, transaction, type Conn } from "../../lib/db";
import { badRequest, handler, notFound, parse } from "../../lib/http";
import { MAX_AMOUNT_MINOR } from "../../money/amounts";
import { moneyId } from "../../money/review";
import { highlightsOf, packageFromDb, SELECT_PACKAGE, type PackageRow } from "../../mt5/packages";
import { requirePermission, requireStepUp, staffActor, staffOf } from "../../staff/session";

// Account packages: what clients choose from when they open a real account,
// and the MT5 group (on one server) each opens accounts in. Changing a
// package's group or server affects new accounts only. Clients see the name,
// description, highlights, spread, commission and minimum deposit, exactly as
// written here, in the portal and the app.

const PLAIN = "Use plain text, without links or symbols like < > { }";
const plain = (max: number, label: string, min = 0) =>
  z
    .string({ required_error: `Enter the ${label}`, invalid_type_error: `Enter the ${label}` })
    .trim()
    .min(min, `Enter the ${label}${min > 1 ? ` (at least ${min} characters)` : ""}`)
    .max(max, `Keep the ${label} under ${max + 1} characters`)
    .refine((v) => !NOT_PLAIN.test(v), PLAIN);

const fields = {
  name: plain(60, "name", 2),
  description: plain(300, "description"),
  // The portal refuses the whole list for an empty line, so there are none.
  highlights: z.array(plain(80, "highlight", 1), { invalid_type_error: "Enter the highlights as a list" }).max(8, "Show at most 8 highlights"),
  spreadLabel: plain(40, "spread", 1),
  // The portal refuses the whole list for an empty commission; none is shown as "Unavailable".
  commissionLabel: plain(40, "commission").nullable().transform((v) => (v ? v : null)),
  minDepositCents: z.number({ invalid_type_error: "Enter the minimum deposit in cents, as a whole number" }).int("Enter the minimum deposit in cents, as a whole number").min(0).max(MAX_AMOUNT_MINOR, "This amount is too large"),
  serverCode: z.string({ required_error: "Choose the MT5 server" }).trim().regex(SERVER_CODE, "Choose the MT5 server"),
  mt5Group: z.string({ required_error: "Enter the MT5 group" }).trim().regex(MT5_GROUP, "Enter the MT5 group exactly as the broker named it (letters, digits, \\ _ - . and spaces)"),
  isRecommended: z.boolean(),
  isVisible: z.boolean(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
};
type Fields = { [K in keyof typeof fields]: z.output<(typeof fields)[K]> };

const createBody = z
  .object(fields)
  .partial()
  .required({ name: true, spreadLabel: true, serverCode: true, mt5Group: true })
  .strict();
const updateBody = z.object(fields).partial().strict();

const DEFAULTS: Omit<Fields, "name" | "spreadLabel" | "serverCode" | "mt5Group"> = {
  description: "", highlights: [], commissionLabel: null, minDepositCents: 0, isRecommended: false, isVisible: true, sortOrder: 0,
};

const COLUMNS: Record<keyof Fields, string> = {
  name: "name", description: "description", highlights: "highlights", spreadLabel: "spread_label", commissionLabel: "commission_label",
  minDepositCents: "min_deposit_cents", serverCode: "server_code", mt5Group: "mt5_group", isRecommended: "is_recommended", isVisible: "is_visible", sortOrder: "sort_order",
};

type StaffPackageRow = PackageRow & { server_label: string; updater_name: string | null; accounts: number };
const SELECT_STAFF_PACKAGE = SELECT_PACKAGE.replace(
  "FROM account_packages p",
  `, s.label AS server_label, u.name AS updater_name,
     (SELECT COUNT(*) FROM mt5_accounts a WHERE a.package_id = p.id AND a.status = 'active') AS accounts
   FROM account_packages p JOIN mt5_servers s ON s.code = p.server_code LEFT JOIN staff_users u ON u.id = p.updated_by`,
);

const fromRow = (p: PackageRow): Fields => ({
  name: p.name, description: p.description, highlights: highlightsOf(p), spreadLabel: p.spread_label, commissionLabel: p.commission_label?.trim() ? p.commission_label : null,
  minDepositCents: p.min_deposit_cents, serverCode: p.server_code, mt5Group: p.mt5_group, isRecommended: p.is_recommended === 1, isVisible: p.is_visible === 1, sortOrder: p.sort_order,
});

const present = (p: StaffPackageRow) => ({
  id: p.id,
  ...fromRow(p),
  serverLabel: p.server_label,
  accounts: Number(p.accounts),
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
  updatedBy: p.updated_by === null ? null : { id: Number(p.updated_by), name: p.updater_name ?? "" },
});

/** A column's value as stored: highlights as JSON, flags as 0 or 1. */
const stored = (key: keyof Fields, f: Fields) => {
  const v = f[key];
  if (key === "highlights") return JSON.stringify(v);
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function staffPackagesRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const router = Router();
  const stepUp = requireStepUp(config);
  const ctx = (req: Request) => auditContext(req, staffActor(staffOf(req)));

  async function load(conn: Conn, id: number, lock = false) {
    const p = await one<StaffPackageRow>(conn, `${SELECT_STAFF_PACKAGE} WHERE p.id = ?${lock ? " FOR UPDATE OF p" : ""}`, [id]);
    if (!p) throw notFound("That account package does not exist.");
    return packageFromDb(p);
  }

  /** The server must be one the CRM knows (it may be switched off: the package then waits for it). */
  async function assertServer(conn: Conn, code: string) {
    if (!(await one(conn, "SELECT code FROM mt5_servers WHERE code = ? FOR SHARE", [code]))) {
      throw badRequest("Check the highlighted fields.", [{ field: "serverCode", message: "Choose a server the CRM knows. Add it in the MT5 settings first." }]);
    }
  }

  router.get(
    "/",
    requirePermission("package.view"),
    handler(async (_req, res) => {
      const list = await rows<StaffPackageRow>(db, `${SELECT_STAFF_PACKAGE} ORDER BY p.sort_order, p.id`);
      res.json({ items: list.map(packageFromDb).map(present) });
    }),
  );

  router.post(
    "/",
    requirePermission("package.manage"),
    stepUp,
    handler(async (req, res) => {
      const body = parse(createBody, req.body ?? {});
      const values: Fields = { ...DEFAULTS, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as Fields;
      const staff = staffOf(req);
      const created = await transaction(db, async (conn) => {
        await assertServer(conn, values.serverCode);
        const keys = Object.keys(COLUMNS) as (keyof Fields)[];
        const r = await exec(conn, `INSERT INTO account_packages (${keys.map((k) => COLUMNS[k]).join(", ")}, updated_by) VALUES (${keys.map(() => "?").join(", ")}, ?)`, [
          ...keys.map((k) => stored(k, values)), staff.id,
        ]);
        await writeAudit(conn, ctx(req), { action: "package.created", entityType: "account_package", entityId: r.insertId, after: values });
        return load(conn, r.insertId);
      });
      res.status(201).json(present(created));
    }),
  );

  router.patch(
    "/:id",
    requirePermission("package.manage"),
    stepUp,
    handler(async (req, res) => {
      const id = parse(moneyId, req.params.id);
      const body = parse(updateBody, req.body ?? {});
      const staff = staffOf(req);
      const updated = await transaction(db, async (conn) => {
        const row = await load(conn, id, true);
        const current = fromRow(row);
        const next: Fields = { ...current, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as Fields;
        const changed = (Object.keys(COLUMNS) as (keyof Fields)[]).filter((k) => !same(next[k], current[k]));
        if (!changed.length) return row;
        if (changed.includes("serverCode")) await assertServer(conn, next.serverCode);
        await exec(conn, `UPDATE account_packages SET ${changed.map((k) => `${COLUMNS[k]} = ?`).join(", ")}, updated_by = ? WHERE id = ?`, [
          ...changed.map((k) => stored(k, next)), staff.id, id,
        ]);
        await writeAudit(conn, ctx(req), {
          action: "package.updated", entityType: "account_package", entityId: id,
          before: Object.fromEntries(changed.map((k) => [k, current[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])),
          // Existing accounts keep their group and server: only new accounts open in the new ones.
          ...(changed.includes("serverCode") || changed.includes("mt5Group") ? { meta: { openAccounts: Number(row.accounts) } } : {}),
        });
        return load(conn, id);
      });
      res.json(present(updated));
    }),
  );

  return router;
}
