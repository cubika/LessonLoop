// Service code uses flat fields; PostgreSQL stores their contents in one envelope.
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
] as const;

export function clearJobPayload<T extends object>(job: T): T {
  const value = { ...job } as Record<string, unknown>;
  delete value.payload;
  for (const field of fields) delete value[field];
  return value as T;
}

export function unpackJobPayload(value: Record<string, unknown>) {
  const { payload, ...metadata } = value;
  return { ...metadata, ...(payload as Record<string, unknown> | undefined) };
}

export function packJobPayload(job: Record<string, unknown>) {
  const flat = unpackJobPayload(job);
  const metadata = clearJobPayload(flat);
  const target = flat.verificationTarget as
    | { id: string; revision: number }
    | undefined;
  if (target && !metadata.verificationRef)
    metadata.verificationRef = {
      kind: "experience",
      id: target.id,
      revision: target.revision,
    };
  if (["completed", "failed", "canceled"].includes(String(job.status)))
    return metadata;
  const payload = Object.fromEntries(
    fields
      .filter((field) => flat[field] !== undefined)
      .map((field) => [field, flat[field]]),
  );
  return Object.keys(payload).length ? { ...metadata, payload } : metadata;
}
