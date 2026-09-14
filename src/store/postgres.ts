import pg from "pg";

export interface Entry {
  kind: string;
  id: string;
  scopeId: string;
  revision: number;
  value: Record<string, unknown>;
}
export class Conflict extends Error {
  constructor(message = "revision_conflict") {
    super(message);
  }
}
export class Transaction {
  constructor(private readonly db: pg.PoolClient) {}
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    const r = await this.db.query(
      "SELECT value FROM lessonloop.objects WHERE kind=$1 AND id=$2",
      [kind, id],
    );
    return r.rows[0]?.value as T | undefined;
  }
  async list<T>(kind: string, scopes?: string[]): Promise<T[]> {
    const r = await this.db.query(
      "SELECT value FROM lessonloop.objects WHERE kind=$1 AND ($2::text[] IS NULL OR scope_id=ANY($2)) ORDER BY id",
      [kind, scopes ?? null],
    );
    return r.rows.map((v) => v.value as T);
  }
  async put(entry: Entry, expected: number | null): Promise<void> {
    if (entry.revision !== (expected === null ? 1 : expected + 1))
      throw new Conflict("revision_must_increment");
    if (expected === null) {
      const r = await this.db.query(
        "INSERT INTO lessonloop.objects(kind,id,scope_id,revision,value) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [
          entry.kind,
          entry.id,
          entry.scopeId,
          entry.revision,
          JSON.stringify(entry.value),
        ],
      );
      if (!r.rowCount) throw new Conflict();
    } else {
      const r = await this.db.query(
        "UPDATE lessonloop.objects SET revision=$4,value=$5,updated_at=now() WHERE kind=$1 AND id=$2 AND scope_id=$3 AND revision=$6 RETURNING id",
        [
          entry.kind,
          entry.id,
          entry.scopeId,
          entry.revision,
          JSON.stringify(entry.value),
          expected,
        ],
      );
      if (!r.rowCount) throw new Conflict();
    }
  }
  async remove(kind: string, id: string, expected: number) {
    const r = await this.db.query(
      "DELETE FROM lessonloop.objects WHERE kind=$1 AND id=$2 AND revision=$3 RETURNING id",
      [kind, id, expected],
    );
    if (!r.rowCount) throw new Conflict();
  }
  async history(kind: string, id: string): Promise<Record<string, unknown>[]> {
    return (
      await this.db.query(
        "SELECT value FROM lessonloop.history WHERE kind=$1 AND id=$2 AND created_at>now()-interval '90 days' ORDER BY revision DESC LIMIT 10",
        [kind, id],
      )
    ).rows.map((v) => v.value);
  }
  async snapshot(entry: Entry) {
    await this.db.query(
      "INSERT INTO lessonloop.history(kind,id,revision,value) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [entry.kind, entry.id, entry.revision, JSON.stringify(entry.value)],
    );
    await this.db.query(
      "DELETE FROM lessonloop.history WHERE kind=$1 AND id=$2 AND (created_at<=now()-interval '90 days' OR revision NOT IN (SELECT revision FROM lessonloop.history WHERE kind=$1 AND id=$2 ORDER BY revision DESC LIMIT 10))",
      [entry.kind, entry.id],
    );
  }
  async eraseHistory(kind: string, id: string) {
    await this.db.query(
      "DELETE FROM lessonloop.history WHERE kind=$1 AND id=$2",
      [kind, id],
    );
  }
  async listHistory<T>(kind: string, scopeId: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT value FROM lessonloop.history WHERE kind=$1 AND value->>'scopeId'=$2",
      [kind, scopeId],
    );
    return result.rows.map((row) => row.value as T);
  }
  async eraseHistoryRevisions(kind: string, id: string, revisions: number[]) {
    await this.db.query(
      "DELETE FROM lessonloop.history WHERE kind=$1 AND id=$2 AND revision=ANY($3::bigint[])",
      [kind, id, revisions],
    );
  }
}
export class ProductStore {
  private readonly pool: pg.Pool;
  private owner: pg.PoolClient | undefined;
  private ready = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      application_name: "lessonloop",
    });
    this.pool.on("error", () => {
      this.ready = false;
    });
  }
  async open(initialize = false) {
    if (this.owner) throw new Error("store_already_open");
    this.owner = await this.pool.connect();
    try {
      this.owner.on("error", () => {
        this.ready = false;
      });
      if (
        !(
          await this.owner.query(
            "SELECT pg_try_advisory_lock(761259483) AS locked",
          )
        ).rows[0].locked
      ) {
        this.owner.release();
        this.owner = undefined;
        throw new Error("another_core_owns_database");
      }
      const exists = (
        await this.owner.query(
          "SELECT to_regclass('lessonloop.schema_version') AS name",
        )
      ).rows[0].name;
      if (!exists && !initialize)
        throw new Error("product_store_missing_run_explicit_setup");
      if (!exists) {
        await this.owner.query(`BEGIN;
        CREATE SCHEMA IF NOT EXISTS lessonloop;
        CREATE TABLE lessonloop.schema_version(version integer PRIMARY KEY);
        INSERT INTO lessonloop.schema_version VALUES(1);
        CREATE TABLE lessonloop.objects(kind text NOT NULL,id text NOT NULL,scope_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id));
        CREATE INDEX objects_scope_kind ON lessonloop.objects(scope_id,kind);
        CREATE TABLE lessonloop.history(kind text NOT NULL,id text NOT NULL,revision bigint NOT NULL,value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id,revision));
        COMMIT;`);
      }
      const versions = await this.owner.query(
        "SELECT version FROM lessonloop.schema_version",
      );
      if (versions.rows.length !== 1 || versions.rows[0].version !== 1)
        throw new Error("incompatible_product_schema");
      this.ready = true;
    } catch (error) {
      if (this.owner) {
        await this.owner.query("ROLLBACK").catch(() => undefined);
        await this.owner
          .query("SELECT pg_advisory_unlock(761259483)")
          .catch(() => undefined);
        this.owner.release();
        this.owner = undefined;
      }
      throw error;
    }
  }
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = async () => {
      const db = this.owner;
      if (!this.ready || !db) throw new Error("product_store_unavailable");
      // Transactions use the same connection that owns the singleton lock. A lost
      // lock therefore also aborts the transaction; another core cannot overlap it.
      try {
        await db.query("BEGIN");
        const result = await fn(new Transaction(db));
        if (!this.ready) throw new Error("writer_ownership_lost");
        await db.query("COMMIT");
        return result;
      } catch (e) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async close() {
    await this.tail;
    this.ready = false;
    if (this.owner) {
      await this.owner
        .query("SELECT pg_advisory_unlock(761259483)")
        .catch(() => undefined);
      this.owner.release();
      this.owner = undefined;
    }
    await this.pool.end();
  }
}
