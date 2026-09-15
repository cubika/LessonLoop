import type pg from "pg";

const fields = [
  "candidate",
  "verdict",
  "modelQuery",
  "assessmentQuery",
  "retainedSupport",
  "comparisonPlaybooks",
  "verificationTarget",
  "verificationControl",
  "inputSources",
  "promptVersion",
  "modelSchema",
  "assessmentSchema",
  "modelQueryHash",
  "assessmentQueryHash",
  "repairReasons",
];

// Normalize old records at startup. Runtime reads and writes use payload directly.
export async function migrateJobPayloads(db: pg.PoolClient) {
  await db.query(
    `
    WITH legacy AS (
      SELECT id, value,
        COALESCE((SELECT jsonb_object_agg(key, val) FROM jsonb_each(value) AS f(key, val) WHERE key=ANY($1::text[])), '{}'::jsonb)
          || COALESCE(value->'payload', '{}'::jsonb) AS payload
      FROM lessonloop.objects WHERE kind='job' AND
        (value ?| $1::text[] OR (value->>'status' IN ('completed','failed','canceled') AND value ? 'payload'))
    )
    UPDATE lessonloop.objects o SET value=
      (legacy.value - $1::text[] - 'payload')
      || CASE WHEN NOT legacy.value ? 'verificationRef' AND legacy.payload->'verificationTarget'->>'id' IS NOT NULL
         THEN jsonb_build_object('verificationRef', jsonb_build_object('kind','experience','id',legacy.payload->'verificationTarget'->'id','revision',legacy.payload->'verificationTarget'->'revision')) ELSE '{}'::jsonb END
      || CASE WHEN legacy.value->>'status' IN ('completed','failed','canceled') OR legacy.payload='{}'::jsonb
         THEN '{}'::jsonb ELSE jsonb_build_object('payload',legacy.payload) END
    FROM legacy WHERE o.kind='job' AND o.id=legacy.id
  `,
    [fields],
  );
}
