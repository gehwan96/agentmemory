import type { StateKV } from "../state/kv.js";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import { resolveCanonicalProject } from "./project-aliases.js";
import { suggestAliasIfNew } from "./project-alias-suggest.js";
import { logger } from "../logger.js";

export async function resolveProject(
  sessionId: string | undefined,
  kv: StateKV,
): Promise<string> {
  if (!sessionId) {
    // No session ID provided — project cannot be determined.
    // Recall will be scoped to memories explicitly tagged "default" plus
    // any legacy (undefined-project) entries.  Callers should always pass
    // the current session ID to enable proper project isolation.
    return "default";
  }

  if (sessionId === "unknown") {
    // Hook fallback value — the Claude Code hook payload didn't carry a
    // session_id.  Log a warning so operators can diagnose the gap; fall
    // through to the KV lookup which will also miss and return "default".
    logger.warn("resolveProject: sessionId is 'unknown' (hook fallback) — project isolation will not apply for this call");
  }

  const session = await kv.get<Session>(KV.sessions, sessionId);

  if (!session) {
    // Session record not found: either sessionId is stale, wrong, or the
    // store hasn't been populated yet.  Return "default" rather than
    // crashing; callers that need strict isolation should verify sessionId.
    return "default";
  }

  const project = resolveCanonicalProject(session.project || "default");

  // Fire-and-forget: detect new project values and suggest aliases automatically.
  if (project !== "default") {
    void suggestAliasIfNew(project, kv);
  }

  return project;
}
