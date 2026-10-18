import { z } from "zod";

/** Shared list-query parsing: page, page size, sort column and direction. */
export function listQuery<S extends string>(sortable: readonly [S, ...S[]], defaultSort: S) {
  return z.object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(sortable).default(defaultSort),
    dir: z.enum(["asc", "desc"]).default("desc"),
    q: z.string().trim().max(120).optional(),
  });
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export const toPage = <T>(items: T[], total: number, page: number, pageSize: number): Page<T> => ({
  items,
  page,
  pageSize,
  total,
  pages: Math.max(1, Math.ceil(total / pageSize)),
});

/** Escapes LIKE wildcards in user search text. */
export const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
