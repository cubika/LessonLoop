import type { HindsightEngine } from "../adapters/hindsight/engine.js";
import { modelUsage, type OperationUsage } from "./usage.js";

type NativeModelEngine = Pick<
  HindsightEngine,
  | "findModelOperation"
  | "createModel"
  | "cancelModelSubmission"
  | "operation"
  | "model"
>;

type NativeModelResult =
  | { status: "waiting" }
  | {
      status: "failed";
      reason: "native_operation_failed" | "native_request_unavailable";
    }
  | { status: "completed"; output: unknown; usage: OperationUsage | undefined };

// The caller freezes the request before submission and owns product state changes.
export async function advanceNativeModel(
  engine: NativeModelEngine,
  request: {
    scopeId: string;
    modelId: string;
    operationId?: string | undefined;
    query?: string | (() => string) | undefined;
    sourceRefs: string[];
    schema: Record<string, unknown>;
  },
  rememberOperation: (operationId: string) => Promise<void>,
): Promise<NativeModelResult> {
  const { scopeId, modelId } = request;
  let operationId =
    request.operationId ?? (await engine.findModelOperation(scopeId, modelId));
  let submitted = false;
  if (!operationId) {
    if (request.query !== undefined) {
      const accepted = await engine.createModel(
        scopeId,
        modelId,
        typeof request.query === "function" ? request.query() : request.query,
        request.sourceRefs,
        request.schema,
      );
      operationId = accepted.operation_id;
      submitted = true;
    } else {
      // Older records may have no replayable request. Close the submission under
      // the native lock before failing; an in-flight request may still have won.
      const closed = await engine.cancelModelSubmission(scopeId, modelId);
      operationId = closed.operation_id ?? undefined;
      if (!operationId && closed.submission_canceled)
        return { status: "failed", reason: "native_request_unavailable" };
    }
  }
  if (!operationId) throw new Error("native_model_identity_unconfirmed");
  if (operationId !== request.operationId) await rememberOperation(operationId);
  if (submitted) return { status: "waiting" };

  const operation = await engine.operation(scopeId, operationId);
  if (operation.status === "failed" || operation.status === "cancelled")
    return { status: "failed", reason: "native_operation_failed" };
  if (operation.status === "not_found")
    throw new Error("native_operation_unconfirmed");
  if (operation.status !== "completed") return { status: "waiting" };
  const model = await engine.model(scopeId, modelId);
  return {
    status: "completed",
    output: model.reflect_response?.structured_output,
    usage: modelUsage(model),
  };
}
