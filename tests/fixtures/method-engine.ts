import { HindsightEngine as NativeEngine } from "../../src/adapters/hindsight/engine.js";
import { digest } from "../../src/domain/schema.js";
import type {
  PlaybookContent,
  PlaybookWrite,
} from "../../src/store/method-content.js";

// Database integration tests isolate native I/O. The Python lifecycle suite
// independently exercises the real engine, routes, guard and durable writes.
const contents = new Map<string, PlaybookContent>();
export class HindsightEngine extends NativeEngine {
  override async clearPlaybookCandidates() {}
  override async readPlaybookContent(
    scopeId: string,
    id: string,
    hash: string,
  ) {
    const value = contents.get(scopeId + ":" + id);
    if (!value || digest(value) !== hash)
      throw new Error("playbook_content_unavailable");
    return structuredClone(value);
  }
  override async writePlaybookContent(write: PlaybookWrite) {
    const key = write.scopeId + ":" + write.id;
    if (write.content) contents.set(key, structuredClone(write.content));
    else contents.delete(key);
  }
}
