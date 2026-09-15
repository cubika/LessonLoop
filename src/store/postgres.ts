import pg from "pg";
import { migrateFeedback } from "./feedback-migration.js";
import { randomUUID } from "node:crypto";
import { digest, playbookSchema, type Playbook } from "../domain/schema.js";
import {
  splitPlaybook,
  type PlaybookContentStore,
  type PlaybookRecord,
  type PlaybookWrite,
} from "./playbook-content.js";

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
  constructor(
    private readonly db: pg.PoolClient,
    private readonly contents?: PlaybookContentStore,
  ) {}
  private async hydrate(value: PlaybookRecord): Promise<Playbook> {
    const pending = await this.get<PlaybookWrite>("playbook_write", value.id);
    const content =
      pending?.hash === value.contentHash && pending.content
        ? pending.content
        : await this.contents?.readPlaybookContent(
            value.scopeId,
            value.id,
            value.contentHash,
          );
    if (!content || digest(content) !== value.contentHash)
      throw new Error("playbook_content_unavailable");
    const { contentHash: _hash, planHash: _plan, ...record } = value;
    return playbookSchema.parse({ ...record, ...content });
  }
  async get<T>(
    kind: string,
    id: string,
    metadataOnly = false,
  ): Promise<T | undefined> {
    const r = await this.db.query(
      "SELECT value FROM lessonloop.objects WHERE kind=$1 AND id=$2",
      [kind, id],
    );
    const value = r.rows[0]?.value;
    return (
      value && kind === "playbook" && !metadataOnly
        ? await this.hydrate(value)
        : value
    ) as T | undefined;
  }
  async readablePlaybook(id: string): Promise<Playbook | undefined> {
    try {
      return await this.get<Playbook>("playbook", id);
    } catch (error) {
      if (error instanceof Conflict) throw error;
      return undefined;
    }
  }
  async list<T>(
    kind: string,
    scopes?: string[],
    metadataOnly = false,
  ): Promise<T[]> {
    const r = await this.db.query(
      "SELECT value FROM lessonloop.objects WHERE kind=$1 AND ($2::text[] IS NULL OR scope_id=ANY($2)) ORDER BY id",
      [kind, scopes ?? null],
    );
    const values = r.rows.map((v) => v.value);
    if (kind !== "playbook" || metadataOnly) return values as T[];
    const results = await Promise.allSettled(
      values.map((v) => this.hydrate(v)),
    );
    return results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value as T] : [],
    );
  }
  async put(entry: Entry, expected: number | null): Promise<void> {
    if (entry.revision !== (expected === null ? 1 : expected + 1))
      throw new Conflict("revision_must_increment");
    if (
      ["job", "revision_review"].includes(entry.kind) &&
      ["completed", "failed", "canceled"].includes(String(entry.value.status))
    ) {
      const value = { ...entry.value };
      for (const field of [
        "candidate",
        "modelQuery",
        "assessmentQuery",
        "comparisonPlaybooks",
        "retainedSupport",
        "verificationTarget",
        "verificationControl",
      ])
        delete value[field];
      entry = { ...entry, value };
    }
    if (entry.kind === "playbook" && "steps" in entry.value) {
      const { content, record } = splitPlaybook(
        playbookSchema.parse(entry.value),
      );
      const old = await this.get<PlaybookRecord>("playbook", entry.id, true);
      if (old?.contentHash !== record.contentHash) {
        const pending = await this.get<PlaybookWrite>(
          "playbook_write",
          entry.id,
        );
        const value = {
          token: randomUUID(),
          previousSupport: [
            ...new Map(
              [
                ...(pending?.previousSupport ?? []),
                ...(old?.supportRefs ?? []),
              ].map((r) => [r.id + ":" + r.revision, r]),
            ).values(),
          ],
          id: entry.id,
          scopeId: entry.scopeId,
          revision: (pending?.revision ?? 0) + 1,
          hash: record.contentHash,
          content,
        };
        await this.put(
          { ...entry, kind: "playbook_write", revision: value.revision, value },
          pending?.revision ?? null,
        );
      }
      entry = { ...entry, value: record as unknown as Record<string, unknown> };
    }
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
    if (kind === "playbook") {
      const playbook = await this.get<PlaybookRecord>(kind, id, true);
      if (!playbook || playbook.revision !== expected) throw new Conflict();
      const pending = await this.get<PlaybookWrite>("playbook_write", id);
      const value = {
        token: randomUUID(),
        previousSupport: [
          ...(pending?.previousSupport ?? []),
          ...playbook.supportRefs,
        ],
        id,
        scopeId: playbook.scopeId,
        revision: (pending?.revision ?? 0) + 1,
        hash: "",
      };
      await this.put(
        {
          kind: "playbook_write",
          id,
          scopeId: playbook.scopeId,
          revision: value.revision,
          value,
        },
        pending?.revision ?? null,
      );
    }
    const r = await this.db.query(
      "DELETE FROM lessonloop.objects WHERE kind=$1 AND id=$2 AND revision=$3 RETURNING id",
      [kind, id, expected],
    );
    if (!r.rowCount) throw new Conflict();
  }
}
export class ProductStore {
  playbookContents?: PlaybookContentStore;
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
        INSERT INTO lessonloop.schema_version VALUES(3);
        CREATE TABLE lessonloop.objects(kind text NOT NULL,id text NOT NULL,scope_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id));
        CREATE INDEX objects_scope_kind ON lessonloop.objects(scope_id,kind);
        COMMIT;`);
      }
      const versions = await this.owner.query(
        "SELECT version FROM lessonloop.schema_version",
      );
      if (versions.rows.length !== 1 || versions.rows[0].version !== 3)
        throw new Error("incompatible_product_schema");
      await migrateFeedback(this.owner);
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
        // Native content commits take this same transaction lock while checking
        // the durable write intent. User/source changes cannot pass that check.
        await db.query("SELECT pg_advisory_xact_lock(761259484)");
        const result = await fn(new Transaction(db, this.playbookContents));
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
