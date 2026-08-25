/**
 * @dsh-git/memory — self-evolving git memory.
 *
 * A durable, cross-session store of environment facts, per-project
 * conventions, error signatures + resolutions, and user-stated preferences.
 *
 * Design:
 * - Storage is a zod-validated KV table in a `git.memory` storage domain
 *   (host `storageDomain`), keyed by content hash so repeated events dedupe
 *   and accumulate a `hits` count (recurring patterns surface automatically).
 * - Auto-capture listens to `tools/result` for git tools: every failure is
 *   recorded with its `tool:action:code` signature; a later success of the
 *   same signature marks the open error resolved.
 * - Secrets are scrubbed before persisting (tokens, keys, private-key blocks,
 *   absolute paths containing a username).
 * - A bounded digest of high-value entries is injected into the system prompt
 *   as a section, so the model pre-empts known errors and follows established
 *   conventions — memory informs defaults, it never overrides an explicit
 *   instruction.
 */
import { z as zod } from 'zod';
import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
declare const entrySchema: zod.ZodObject<{
    key: zod.ZodString;
    kind: zod.ZodEnum<{
        fact: "fact";
        project: "project";
        error: "error";
        preference: "preference";
    }>;
    scope: zod.ZodObject<{
        project: zod.ZodOptional<zod.ZodString>;
        environment: zod.ZodOptional<zod.ZodString>;
    }, zod.core.$strip>;
    text: zod.ZodString;
    source: zod.ZodEnum<{
        observed: "observed";
        stated: "stated";
        inferred: "inferred";
    }>;
    status: zod.ZodDefault<zod.ZodEnum<{
        open: "open";
        resolved: "resolved";
    }>>;
    hits: zod.ZodDefault<zod.ZodNumber>;
    fix: zod.ZodOptional<zod.ZodString>;
    createdAt: zod.ZodNumber;
    updatedAt: zod.ZodNumber;
    resolvedAt: zod.ZodOptional<zod.ZodNumber>;
}, zod.core.$strip>;
export type GitMemoryEntry = zod.infer<typeof entrySchema>;
export type GitMemoryKind = GitMemoryEntry['kind'];
export type GitMemorySource = GitMemoryEntry['source'];
export declare class GitMemoryError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
export interface GitMemoryConfig {
    enabled?: boolean;
    maxEntries?: number;
    digestLimit?: number;
}
type ResolvedGitMemoryConfig = {
    enabled: boolean;
    maxEntries: number;
    digestLimit: number;
};
/** Best-effort secret scrub: tokens, keys, private-key blocks, username paths. */
export declare function scrub(text: string): string;
export declare class GitMemoryService extends Service {
    static inject: string[];
    static Config: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        maxEntries: z<number, number>;
        digestLimit: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        maxEntries: z<number, number>;
        digestLimit: z<number, number>;
    }>>;
    readonly config: ResolvedGitMemoryConfig;
    private ready;
    private domain;
    private table;
    private digestCache;
    constructor(ctx: Context, config: GitMemoryConfig);
    private open;
    private ensureTable;
    private environment;
    private refreshDigest;
    /** Record one entry; same key bumps `hits` instead of duplicating. */
    record(input: {
        kind: GitMemoryKind;
        text: string;
        project?: string;
        source?: GitMemorySource;
        key?: string;
        fix?: string;
        status?: 'open' | 'resolved';
    }): Promise<GitMemoryEntry>;
    /** Query entries; sorted by hits then recency. */
    recall(query?: {
        kind?: GitMemoryKind;
        project?: string;
        text?: string;
        status?: 'open' | 'resolved';
        limit?: number;
    }): Promise<GitMemoryEntry[]>;
    /** Delete one entry (superseding stale memory). */
    forget(key: string): Promise<boolean>;
    /** Auto-capture hook driven by `tools/result`: record failures, resolve on success. */
    observe(exec: ToolExecution, result: ToolExecutionResult): Promise<void>;
    /** Bound the table: evict lowest-hit / oldest entries beyond maxEntries. */
    private enforceCap;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        gitMemory: GitMemoryService;
    }
}
export default GitMemoryService;
//# sourceMappingURL=index.d.ts.map