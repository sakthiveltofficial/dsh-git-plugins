/**
 * @dsh-git/core — Service Definitions for the Git capability seam.
 *
 * Three concerns share one package (one vocabulary, one error taxonomy):
 *
 * - `gitLocal`  (GitLocalService): provider-agnostic git plumbing/porcelain —
 *   clone/branch/checkout/commit/push/pull/diff/blame/tag/log/stash/merge/rebase,
 *   local code/file search, and remote discovery. Exactly one provider
 *   (`@dsh-git/local` shells to the git binary); the seam stays abstract for
 *   test doubles and future libgit2/dugite backends.
 *
 * - `gitPlatform` (GitPlatformService): a hosted-platform REGISTRY/dispatcher.
 *   A Cordis service name registers once per realm, so "one seam, many hosts"
 *   is one registry plus many registered adapters (`registerProvider`), exactly
 *   like `ctx.web.registerFetchProvider` and `ctx.llm.registerAdapter`.
 *   Adapters live in `@dsh-git/github`, `-gitlab`, `-bitbucket`,
 *   `-azuredevops`, and `-gitea`.
 *
 * - HTTP plumbing: `gitFetchJson` + the typed error mapping, shared by every
 *   adapter (Node's global fetch; persistent plugins are normal host code).
 *
 * Consumers depend only on this package — never on a specific provider.
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
export type GitErrorCode = 'GIT_NOT_FOUND' | 'GIT_NOT_A_REPO' | 'GIT_DIRTY' | 'GIT_CONFLICT' | 'GIT_AUTH_FAILED' | 'GIT_RATE_LIMITED' | 'GIT_NETWORK' | 'GIT_TIMEOUT' | 'GIT_ABORTED' | 'GIT_FAILED' | 'GIT_INVALID_ARGS' | 'GIT_SANDBOX_DENIED' | 'GIT_UNSUPPORTED';
/** Typed git error; route on `code`, never by parsing `message`. */
export declare class GitError extends HarnessError {
    readonly code: GitErrorCode;
    /** HTTP status when the failure came from an API response, else undefined. */
    readonly status?: number;
    constructor(message: string, code: GitErrorCode, options?: ErrorOptions & {
        status?: number;
    });
}
export interface GitHttpOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
}
/**
 * One JSON HTTP request through Node's global fetch with the seam's error
 * mapping: abort → GIT_ABORTED, transport failure → GIT_NETWORK, 401 →
 * GIT_AUTH_FAILED, 429/403 → GIT_RATE_LIMITED, other non-2xx → GIT_FAILED.
 */
export declare function gitFetchJson(url: string, options?: GitHttpOptions): Promise<unknown>;
export interface ParsedRemote {
    host: string;
    /** Owner path; may contain slashes (GitLab subgroups, Azure DevOps projects). */
    owner: string;
    repo: string;
}
/**
 * Parse a git remote URL (https, ssh, or SCP-style) into host/owner/repo.
 * Supports Azure DevOps `_git` layout and multi-segment owners.
 */
export declare function parseRemote(url: string): ParsedRemote | null;
/** Encode an owner path and repo for an API path, preserving owner slashes. */
export declare function encodeRepoPath(owner: string, repo: string): string;
/** Present on every MUTATING request; the tool layer stamps the resolved sandbox policy. */
export interface SandboxedRequest {
    sandboxPolicy?: SandboxExecutionPolicy;
}
export interface RemoteRequest {
    workdir: string;
    signal?: AbortSignal;
}
export interface RemoteResult {
    name: string;
    url: string;
    /** Host from the URL (e.g. `github.com`), or null when unparseable. */
    host: string | null;
}
export interface CloneRequest extends SandboxedRequest {
    url: string;
    destination: string;
    /** Parent directory a relative `destination` resolves against (defaults to provider cwd). */
    workdir?: string;
    branch?: string;
    depth?: number;
    signal?: AbortSignal;
}
export interface CloneResult {
    destination: string;
    branch: string;
    remoteUrl: string;
}
export interface BranchRequest extends SandboxedRequest {
    workdir: string;
    /** Create a branch with this name (omit to list). */
    name?: string;
    delete?: boolean;
    /** List remote-tracking branches (`-r`) instead of local. */
    remote?: boolean;
    signal?: AbortSignal;
}
export interface BranchResult {
    current: string;
    branches: string[];
}
export interface CheckoutRequest extends SandboxedRequest {
    workdir: string;
    ref: string;
    /** Create a new branch at `ref` (`-b`) instead of switching. */
    create?: boolean;
    force?: boolean;
    signal?: AbortSignal;
}
export interface CheckoutResult {
    ref: string;
    current: string;
}
export interface CommitRequest extends SandboxedRequest {
    workdir: string;
    message: string;
    /** Stage tracked modifications and commit (`-a`). */
    all?: boolean;
    amend?: boolean;
    signal?: AbortSignal;
}
export interface CommitResult {
    hash: string;
    summary: string;
}
export interface PushRequest extends SandboxedRequest {
    workdir: string;
    remote?: string;
    branch?: string;
    /** Use `--force-with-lease` rather than a plain push. */
    force?: boolean;
    /** Set upstream tracking (`-u`). */
    setUpstream?: boolean;
    signal?: AbortSignal;
}
export interface PushResult {
    ok: boolean;
    remote: string;
    branch: string;
    summary: string;
}
export interface PullRequest extends SandboxedRequest {
    workdir: string;
    remote?: string;
    branch?: string;
    rebase?: boolean;
    signal?: AbortSignal;
}
export interface PullResult {
    ok: boolean;
    summary: string;
}
export interface DiffRequest {
    workdir: string;
    staged?: boolean;
    pathspec?: string[];
    context?: number;
    signal?: AbortSignal;
}
export interface DiffResult {
    patch: string;
    truncated: boolean;
}
export interface BlameRequest {
    workdir: string;
    file: string;
    signal?: AbortSignal;
}
export interface BlameResult {
    file: string;
    text: string;
}
export interface LogRequest {
    workdir: string;
    maxCount?: number;
    pathspec?: string[];
    signal?: AbortSignal;
}
export interface LogEntry {
    hash: string;
    author: string;
    date: string;
    subject: string;
}
export interface LogResult {
    entries: LogEntry[];
}
export interface TagRequest extends SandboxedRequest {
    workdir: string;
    action: 'list' | 'create' | 'delete';
    name?: string;
    message?: string;
    ref?: string;
    signal?: AbortSignal;
}
export interface TagResult {
    tags: string[];
    summary?: string;
}
export interface StashRequest extends SandboxedRequest {
    workdir: string;
    action: 'list' | 'push' | 'pop' | 'apply' | 'drop';
    message?: string;
    ref?: string;
    signal?: AbortSignal;
}
export interface StashEntry {
    ref: string;
    subject: string;
}
export interface StashResult {
    entries: StashEntry[];
    summary?: string;
}
export interface MergeRequest extends SandboxedRequest {
    workdir: string;
    branch: string;
    noCommit?: boolean;
    abort?: boolean;
    signal?: AbortSignal;
}
export interface MergeResult {
    ok: boolean;
    conflicted: boolean;
    summary: string;
}
export interface RebaseRequest extends SandboxedRequest {
    workdir: string;
    onto?: string;
    abort?: boolean;
    cont?: boolean;
    signal?: AbortSignal;
}
export interface RebaseResult {
    ok: boolean;
    summary: string;
}
export interface CodeSearchRequest {
    workdir: string;
    query: string;
    pathspec?: string[];
    signal?: AbortSignal;
}
export interface CodeSearchResult {
    path: string;
    line: number;
    text: string;
}
export interface FileSearchRequest {
    workdir: string;
    pattern: string;
    signal?: AbortSignal;
}
export interface InitRequest {
    workdir: string;
    defaultBranch?: string;
    signal?: AbortSignal;
}
export interface InitResult {
    workdir: string;
    branch: string;
}
export interface AddRequest extends SandboxedRequest {
    workdir: string;
    /** Paths to stage; omit (or set `all`) to stage everything (`git add --all`). */
    paths?: string[];
    all?: boolean;
    signal?: AbortSignal;
}
export interface AddResult {
    staged: string[];
}
export interface StatusRequest {
    workdir: string;
    signal?: AbortSignal;
}
export interface StatusEntry {
    path: string;
    /** Two-letter porcelain state (e.g. `M `, ` M`, `??`). */
    state: string;
    staged: boolean;
}
export interface StatusResult {
    branch: string;
    clean: boolean;
    entries: StatusEntry[];
}
export interface RemoteAddRequest extends SandboxedRequest {
    workdir: string;
    /** Remote name (default `origin`). */
    name?: string;
    url: string;
    signal?: AbortSignal;
}
export interface RemoteAddResult {
    name: string;
    url: string;
}
export declare abstract class GitLocalService extends Service {
    constructor(ctx: Context);
    abstract remote(req: RemoteRequest): Promise<RemoteResult>;
    abstract init(req: InitRequest): Promise<InitResult>;
    abstract add(req: AddRequest): Promise<AddResult>;
    abstract status(req: StatusRequest): Promise<StatusResult>;
    abstract remoteAdd(req: RemoteAddRequest): Promise<RemoteAddResult>;
    abstract clone(req: CloneRequest): Promise<CloneResult>;
    abstract branch(req: BranchRequest): Promise<BranchResult>;
    abstract checkout(req: CheckoutRequest): Promise<CheckoutResult>;
    abstract commit(req: CommitRequest): Promise<CommitResult>;
    abstract push(req: PushRequest): Promise<PushResult>;
    abstract pull(req: PullRequest): Promise<PullResult>;
    abstract diff(req: DiffRequest): Promise<DiffResult>;
    abstract blame(req: BlameRequest): Promise<BlameResult>;
    abstract log(req: LogRequest): Promise<LogResult>;
    abstract tag(req: TagRequest): Promise<TagResult>;
    abstract stash(req: StashRequest): Promise<StashResult>;
    abstract merge(req: MergeRequest): Promise<MergeResult>;
    abstract rebase(req: RebaseRequest): Promise<RebaseResult>;
    abstract searchCode(req: CodeSearchRequest): Promise<CodeSearchResult[]>;
    abstract searchFiles(req: FileSearchRequest): Promise<string[]>;
}
export type GitPlatform = 'github' | 'gitlab' | 'bitbucket' | 'azuredevops' | 'gitea';
/** Every dispatch request may carry an explicit platform or a remote URL to detect from. */
export interface GitPlatformContext {
    platform?: GitPlatform;
    remoteUrl?: string;
}
export interface PullRequestCreateRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    signal?: AbortSignal;
}
export interface PullRequestResult {
    number: number;
    url: string;
    title: string;
    state: string;
}
export interface PullRequestListRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    limit?: number;
    signal?: AbortSignal;
}
export interface PullRequestSummary {
    number: number;
    title: string;
    state: string;
    url: string;
    head: string;
    base: string;
    author: string;
    createdAt: string;
    mergeable?: boolean;
}
export interface PullRequestMergeRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    number: number;
    method?: 'merge' | 'squash' | 'rebase';
    signal?: AbortSignal;
}
export interface ReviewCommentRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
    signal?: AbortSignal;
}
export interface IssueListRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    limit?: number;
    signal?: AbortSignal;
}
export interface Issue {
    number: number;
    title: string;
    state: string;
    url: string;
    author: string;
    createdAt: string;
    body?: string;
    labels: string[];
}
export interface IssueCreateRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    signal?: AbortSignal;
}
export interface ReleaseCreateRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    tag: string;
    name?: string;
    body?: string;
    /** Target commit/ref the release points at (defaults to the default branch tip). */
    ref?: string;
    draft?: boolean;
    prerelease?: boolean;
    signal?: AbortSignal;
}
export interface Release {
    id: string;
    tag: string;
    name: string;
    url: string;
    draft: boolean;
    prerelease: boolean;
}
export interface SecurityAlertListRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    signal?: AbortSignal;
}
export interface SecurityAlert {
    id: string;
    severity: string;
    package: string;
    advisory: string;
    state: string;
    url?: string;
}
export interface PipelineListRequest extends GitPlatformContext {
    owner: string;
    repo: string;
    branch?: string;
    limit?: number;
    signal?: AbortSignal;
}
export interface PipelineRun {
    id: string;
    name: string;
    status: string;
    conclusion?: string;
    url: string;
    branch?: string;
    createdAt?: string;
}
export interface PipelineJob {
    id: string;
    name: string;
    status: string;
    conclusion?: string;
}
export interface PipelineRunDetail {
    id: string;
    name: string;
    status: string;
    conclusion?: string;
    url: string;
    jobs?: PipelineJob[];
}
/**
 * A single hosted-platform adapter. Each adapter implements one host's API
 * shapes and registers itself with `gitPlatform.registerProvider(adapter)`.
 * Every method maps the host response into the seam's normalized vocabulary.
 */
export interface GitPlatformProvider {
    readonly platform: GitPlatform;
    /** True when this adapter owns the given remote URL (e.g. `git@github.com:`). */
    matchesRemote(remoteUrl: string): boolean;
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
export declare abstract class GitPlatformService extends Service {
    constructor(ctx: Context);
    /** Adapters register here; returns a disposer that unregisters the adapter. */
    abstract registerProvider(provider: GitPlatformProvider): () => void;
    abstract createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult>;
    abstract listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]>;
    abstract mergePullRequest(req: PullRequestMergeRequest): Promise<void>;
    abstract addReviewComment(req: ReviewCommentRequest): Promise<void>;
    abstract listIssues(req: IssueListRequest): Promise<Issue[]>;
    abstract createIssue(req: IssueCreateRequest): Promise<Issue>;
    abstract createRelease(req: ReleaseCreateRequest): Promise<Release>;
    abstract listSecurityAlerts(req: SecurityAlertListRequest): Promise<SecurityAlert[]>;
    abstract listPipelines(req: PipelineListRequest): Promise<PipelineRun[]>;
    abstract getPipelineRun(req: PipelineListRequest & {
        id: string;
    }): Promise<PipelineRunDetail>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        gitLocal: GitLocalService;
        gitPlatform: GitPlatformService;
    }
}
//# sourceMappingURL=index.d.ts.map