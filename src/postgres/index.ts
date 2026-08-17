import { Pool } from "pg";
import { postgresConfig } from "../config.js";

class PostgresLink {
  private pool: Pool | null = null;

  async connect(): Promise<void> {
    await this.conn().query("select 1");
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.end();
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    const res = await this.conn().query(sql, params as unknown[]);
    return res.rowCount ?? 0;
  }

  async rows<T extends object>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const res = await this.conn().query<T>(sql, params as unknown[]);
    return res.rows;
  }

  private conn(): Pool {
    if (this.pool) return this.pool;

    const pool = new Pool({
      connectionString: postgresConfig.url,
      max: postgresConfig.poolMax,
    });

    pool.on("error", (err: Error) => {
      console.error("[pg] 空闲连接出错", err);
    });

    this.pool = pool;
    return pool;
  }
}

export const postgres = new PostgresLink();
