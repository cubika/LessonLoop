import { digest, type Method } from "../domain/schema.js";

const fields = [
  "title",
  "goal",
  "topics",
  "conditions",
  "exceptions",
  "steps",
  "completionChecks",
  "stopConditions",
] as const;
export type MethodContent = Pick<Method, (typeof fields)[number]>;
export type MethodRecord = Omit<Method, keyof MethodContent> & {
  contentHash: string;
  planHash: string;
};
export interface MethodWrite {
  token: string;
  id: string;
  scopeId: string;
  revision: number;
  hash: string;
  previousSupport?: Method["supportRefs"];
  content?: MethodContent;
}
export interface MethodContentStore {
  readMethodContent(
    scopeId: string,
    id: string,
    hash: string,
  ): Promise<MethodContent>;
  writeMethodContent(write: MethodWrite): Promise<void>;
}
export function splitMethod(method: Method) {
  const record = { ...method } as Record<string, unknown>;
  const content = Object.fromEntries(
    fields.map((key) => [key, record[key]]),
  ) as MethodContent;
  for (const key of fields) delete record[key];
  return {
    content,
    record: {
      ...record,
      contentHash: digest(content),
      planHash: digest({
        goal: method.goal,
        steps: method.steps,
        conditions: method.conditions,
        exceptions: method.exceptions,
      }),
    } as MethodRecord,
  };
}
