import type { StateKV } from "../state/kv.js";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import { resolveCanonicalProject } from "./project-aliases.js";
import { suggestAliasIfNew } from "./project-alias-suggest.js";

export async function resolveProject(
  sessionId: string | undefined,
  kv: StateKV,
): Promise<string> {
  if (!sessionId) {
    return "default";
  }

  const session = await kv.get<Session>(KV.sessions, sessionId);

  if (!session) {
    return "default";
  }

  const project = resolveCanonicalProject(session.project || "default");

  // Fire-and-forget: detect new project values and suggest aliases automatically.
  if (project !== "default") {
    void suggestAliasIfNew(project, kv);
  }

  return project;
}
