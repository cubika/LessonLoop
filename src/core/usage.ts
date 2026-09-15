export interface OperationUsage {
  input_tokens: number;
  output_tokens: number;
  complete: boolean;
  cached_tokens?: number;
  thoughts_tokens?: number;
}
export function modelUsage(model: unknown): OperationUsage | undefined {
  const response = (model as any)?.reflect_response;
  const value = response?.lessonloop_usage ?? response?.trace?.usage;
  if (
    !value ||
    ![value.input_tokens, value.output_tokens].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  )
    return undefined;
  return {
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    complete: response?.lessonloop_usage?.complete === true,
    ...(typeof value.cached_tokens === "number"
      ? { cached_tokens: value.cached_tokens }
      : {}),
    ...(typeof value.thoughts_tokens === "number"
      ? { thoughts_tokens: value.thoughts_tokens }
      : {}),
  };
}
export function aggregateUsage(
  ids: string[],
  records: Record<string, OperationUsage> = {},
) {
  const unique = [...new Set(ids)];
  const measured = unique.filter((id) => records[id]);
  return {
    status:
      unique.length && unique.every((id) => records[id]?.complete)
        ? "measured"
        : measured.length
          ? "partial"
          : "unknown",
    measuredOperations: measured.length,
    totalOperations: unique.length,
    input_tokens: measured.length
      ? measured.reduce((n, id) => n + records[id]!.input_tokens, 0)
      : null,
    output_tokens: measured.length
      ? measured.reduce((n, id) => n + records[id]!.output_tokens, 0)
      : null,
    unknownOperationIds: unique.filter((id) => !records[id]?.complete),
    nativeOperationIds: unique,
  };
}
