import type { ISdk } from "iii-sdk";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import type { Memory, Session } from "../types.js";
import { logger } from "../logger.js";

/**
 * mem::backfill-project
 *
 * Soaks the project attribution gap left by pre-isolation versions of
 * agentmemory: any Memory whose `project` field is undefined gets the
 * project of its first known session.  After running this, all
 * `Memory` entries are either attributed (project string) or explicitly
 * marked "global" (when no session can be found for them).
 *
 * The function is idempotent: memories that already have `project` set
 * are skipped.  It processes memories in chunks to avoid loading the
 * entire store into memory at once.
 *
 * Returns: { updated, skipped, noSession } counts.
 */
export function registerBackfillProjectFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::backfill-project", async (data: {
    dryRun?: boolean;
    globalFallback?: string;   // project string for orphaned memories; default "global"
  }) => {
    const dryRun = data.dryRun === true;
    const globalFallback = typeof data.globalFallback === "string" && data.globalFallback.trim()
      ? data.globalFallback.trim()
      : "global";

    let updated = 0;
    let skipped = 0;
    let noSession = 0;

    // Session cache to avoid redundant KV reads.
    const sessionCache = new Map<string, Session | null>();
    const loadSession = async (id: string): Promise<Session | null> => {
      if (sessionCache.has(id)) return sessionCache.get(id)!;
      const s = await kv.get<Session>(KV.sessions, id).catch(() => null);
      sessionCache.set(id, s ?? null);
      return s ?? null;
    };

    const memories = await kv.list<Memory>(KV.memories).catch(() => [] as Memory[]);
    logger.info("Backfill project: starting", { total: memories.length, dryRun });

    for (const mem of memories) {
      if (mem.project !== undefined) {
        // Already attributed — skip.
        skipped++;
        continue;
      }

      // Resolve project from the memory's sessions.
      let resolvedProject: string | undefined;
      const sessionIds: string[] = Array.isArray(mem.sessionIds) ? mem.sessionIds : [];

      for (const sid of sessionIds) {
        const session = await loadSession(sid);
        if (session?.project) {
          resolvedProject = session.project;
          break; // use first found session's project
        }
      }

      if (!resolvedProject) {
        // No session found or session has no project.  Tag as globalFallback
        // so this memory stops being a wildcard after backfill completes.
        resolvedProject = globalFallback;
        noSession++;
      }

      if (!dryRun) {
        await kv.set<Memory>(KV.memories, mem.id, { ...mem, project: resolvedProject });
      }
      updated++;
    }

    const result = { success: true, updated, skipped, noSession, dryRun, globalFallback };
    logger.info("Backfill project: complete", result);
    return result;
  });
}
