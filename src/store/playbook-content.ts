import { digest, type Playbook } from "../domain/schema.js";

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
export type PlaybookContent = Pick<Playbook, (typeof fields)[number]>;
export type PlaybookRecord = Omit<Playbook, keyof PlaybookContent> & {
  contentHash: string;
  planHash: string;
};
export interface PlaybookWrite {
  token: string;
  id: string;
  scopeId: string;
  revision: number;
  hash: string;
  previousSupport?: Playbook["supportRefs"];
  content?: PlaybookContent;
}
export interface PlaybookContentStore {
  readPlaybookContent(
    scopeId: string,
    id: string,
    hash: string,
  ): Promise<PlaybookContent>;
  writePlaybookContent(write: PlaybookWrite): Promise<void>;
}
export function splitPlaybook(playbook: Playbook) {
  const record = { ...playbook } as Record<string, unknown>;
  const content = Object.fromEntries(
    fields.map((key) => [key, record[key]]),
  ) as PlaybookContent;
  for (const key of fields) delete record[key];
  return {
    content,
    record: {
      ...record,
      contentHash: digest(content),
      planHash: digest({
        goal: playbook.goal,
        steps: playbook.steps,
        conditions: playbook.conditions,
        exceptions: playbook.exceptions,
      }),
    } as PlaybookRecord,
  };
}
