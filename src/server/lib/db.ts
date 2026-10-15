import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";

export type Db = Pool;
export type Conn = Pool | PoolConnection;

export function createDb(url: string): Db {
  return mysql.createPool({
    uri: url,
    connectionLimit: 10,
    // Store and read every DATETIME as UTC regardless of the server's zone.
    timezone: "Z",
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    namedPlaceholders: false,
    multipleStatements: false,
  });
}

export async function rows<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await conn.query<RowDataPacket[]>(sql, params);
  return result as T[];
}

export async function one<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(conn, sql, params))[0];
}

export async function exec(conn: Conn, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await conn.execute<ResultSetHeader>(sql, params as never[]);
  return result;
}

/** Runs `work` in one transaction; rolls back on any thrown error. */
export async function transaction<T>(db: Db, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}
