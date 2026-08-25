/**
 * @dsh-git/local — the local git provider.
 *
 * Implements `gitLocal` by shelling to the real git binary through `ctx.shell`
 * (the `ShellExecutor` seam). Delegating to git itself keeps edge cases correct:
 * submodules, LFS, hooks, and the index all behave exactly as the user's own
 * `git` does. Every command runs `--no-pager` with `GIT_TERMINAL_PROMPT=0` so a
 * missing credential fails fast instead of hanging on an interactive prompt.
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { GitLocalService, type AddRequest, type AddResult, type BlameRequest, type BlameResult, type BranchRequest, type BranchResult, type CheckoutRequest, type CheckoutResult, type CloneRequest, type CloneResult, type CodeSearchRequest, type CodeSearchResult, type CommitRequest, type CommitResult, type DiffRequest, type DiffResult, type FileSearchRequest, type InitRequest, type InitResult, type LogRequest, type LogResult, type MergeRequest, type MergeResult, type PullRequest, type PullResult, type PushRequest, type PushResult, type RebaseRequest, type RebaseResult, type RemoteAddRequest, type RemoteAddResult, type RemoteRequest, type RemoteResult, type StatusRequest, type StatusResult, type StashRequest, type StashResult, type TagRequest, type TagResult } from '@dsh-git/core';
export interface Config {
    /** Fallback working directory when a request omits one. */
    cwd?: string;
    /** Foreground command timeout, in milliseconds. */
    timeoutMs?: number;
    /** Foreground stdout capture budget, in bytes. */
    stdoutMaxBytes?: number;
}
type ResolvedConfig = {
    cwd: string;
    timeoutMs: number;
    stdoutMaxBytes: number;
};
export declare class LocalGitService extends GitLocalService {
    static inject: string[];
    static Config: z<Schemastery.ObjectS<{
        cwd: z<string, string>;
        timeoutMs: z<number, number>;
        stdoutMaxBytes: z<number, number>;
    }>, Schemastery.ObjectT<{
        cwd: z<string, string>;
        timeoutMs: z<number, number>;
        stdoutMaxBytes: z<number, number>;
    }>>;
    readonly config: ResolvedConfig;
    constructor(ctx: Context, config: Config);
    private git;
    private fatal;
    /** Run a command that must exit 0; returns captured output. */
    private run;
    private currentBranch;
    private revParseHead;
    private remoteUrl;
    /** Branch from HEAD without requiring a commit (unborn HEAD, fresh clones). */
    private resolveHeadBranch;
    remote(req: RemoteRequest): Promise<RemoteResult>;
    init(req: InitRequest): Promise<InitResult>;
    add(req: AddRequest): Promise<AddResult>;
    status(req: StatusRequest): Promise<StatusResult>;
    remoteAdd(req: RemoteAddRequest): Promise<RemoteAddResult>;
    clone(req: CloneRequest): Promise<CloneResult>;
    branch(req: BranchRequest): Promise<BranchResult>;
    checkout(req: CheckoutRequest): Promise<CheckoutResult>;
    commit(req: CommitRequest): Promise<CommitResult>;
    push(req: PushRequest): Promise<PushResult>;
    pull(req: PullRequest): Promise<PullResult>;
    diff(req: DiffRequest): Promise<DiffResult>;
    blame(req: BlameRequest): Promise<BlameResult>;
    log(req: LogRequest): Promise<LogResult>;
    tag(req: TagRequest): Promise<TagResult>;
    stash(req: StashRequest): Promise<StashResult>;
    merge(req: MergeRequest): Promise<MergeResult>;
    rebase(req: RebaseRequest): Promise<RebaseResult>;
    searchCode(req: CodeSearchRequest): Promise<CodeSearchResult[]>;
    searchFiles(req: FileSearchRequest): Promise<string[]>;
}
export default LocalGitService;
//# sourceMappingURL=index.d.ts.map