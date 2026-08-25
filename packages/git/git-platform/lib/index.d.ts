/**
 * @dsh-git/platform — the `gitPlatform` registry/dispatcher.
 *
 * One Cordis service, many adapters. Adapters register with `registerProvider`;
 * every dispatch resolves the owning adapter by explicit `platform`, by remote
 * URL detection (`matchesRemote`), or by the configured `defaultProvider`.
 *
 * Cross-cutting concerns live here so adapters stay thin:
 * - rate-limit / transient retry with exponential backoff (`ctx.timer`);
 * - a bounded TTL read cache (list/get operations only — writes never cached).
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { GitPlatformService, type GitPlatform, type GitPlatformProvider, type Issue, type IssueCreateRequest, type IssueListRequest, type PipelineListRequest, type PipelineRun, type PipelineRunDetail, type PullRequestCreateRequest, type PullRequestListRequest, type PullRequestMergeRequest, type PullRequestResult, type PullRequestSummary, type Release, type ReleaseCreateRequest, type ReviewCommentRequest, type SecurityAlert, type SecurityAlertListRequest } from '@dsh-git/core';
export interface Config {
    /** Fallback platform when neither `platform` nor a detectable `remoteUrl` is given. */
    defaultProvider?: GitPlatform;
    /** Retry attempts for rate-limit / (read-only) network failures. */
    maxRetries?: number;
    /** Base backoff delay, milliseconds (doubles per attempt). */
    backoffMs?: number;
    /** Read-cache TTL, milliseconds; 0 disables the cache. */
    cacheTtlMs?: number;
    /** Read-cache entry cap; the cache clears when exceeded. */
    cacheMaxEntries?: number;
}
type ResolvedConfig = {
    defaultProvider: GitPlatform | undefined;
    maxRetries: number;
    backoffMs: number;
    cacheTtlMs: number;
    cacheMaxEntries: number;
};
export declare class GitPlatformRegistry extends GitPlatformService {
    static inject: string[];
    static Config: z<Schemastery.ObjectS<{
        defaultProvider: z<GitPlatform, GitPlatform>;
        maxRetries: z<number, number>;
        backoffMs: z<number, number>;
        cacheTtlMs: z<number, number>;
        cacheMaxEntries: z<number, number>;
    }>, Schemastery.ObjectT<{
        defaultProvider: z<GitPlatform, GitPlatform>;
        maxRetries: z<number, number>;
        backoffMs: z<number, number>;
        cacheTtlMs: z<number, number>;
        cacheMaxEntries: z<number, number>;
    }>>;
    readonly config: ResolvedConfig;
    private readonly providers;
    private readonly cache;
    constructor(ctx: Context, config: Config);
    registerProvider(provider: GitPlatformProvider): () => void;
    private resolveProvider;
    private call;
    createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult>;
    listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]>;
    mergePullRequest(req: PullRequestMergeRequest): Promise<void>;
    addReviewComment(req: ReviewCommentRequest): Promise<void>;
    listIssues(req: IssueListRequest): Promise<Issue[]>;
    createIssue(req: IssueCreateRequest): Promise<Issue>;
    createRelease(req: ReleaseCreateRequest): Promise<Release>;
    listSecurityAlerts(req: SecurityAlertListRequest): Promise<SecurityAlert[]>;
    listPipelines(req: PipelineListRequest): Promise<PipelineRun[]>;
    getPipelineRun(req: PipelineListRequest & {
        id: string;
    }): Promise<PipelineRunDetail>;
}
export default GitPlatformRegistry;
//# sourceMappingURL=index.d.ts.map