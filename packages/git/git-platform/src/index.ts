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
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import {
  GitPlatformService,
  GitError,
  type GitPlatform,
  type GitPlatformContext,
  type GitPlatformProvider,
  type Issue,
  type IssueCreateRequest,
  type IssueListRequest,
  type PipelineListRequest,
  type PipelineRun,
  type PipelineRunDetail,
  type PullRequestCreateRequest,
  type PullRequestListRequest,
  type PullRequestMergeRequest,
  type PullRequestResult,
  type PullRequestSummary,
  type Release,
  type ReleaseCreateRequest,
  type ReviewCommentRequest,
  type SecurityAlert,
  type SecurityAlertListRequest,
} from '@dsh-git/core'

export interface Config {
  /** Fallback platform when neither `platform` nor a detectable `remoteUrl` is given. */
  defaultProvider?: GitPlatform
  /** Retry attempts for rate-limit / (read-only) network failures. */
  maxRetries?: number
  /** Base backoff delay, milliseconds (doubles per attempt). */
  backoffMs?: number
  /** Read-cache TTL, milliseconds; 0 disables the cache. */
  cacheTtlMs?: number
  /** Read-cache entry cap; the cache clears when exceeded. */
  cacheMaxEntries?: number
}

type ResolvedConfig = {
  defaultProvider: GitPlatform | undefined
  maxRetries: number
  backoffMs: number
  cacheTtlMs: number
  cacheMaxEntries: number
}

interface CacheEntry {
  at: number
  value: unknown
}

const PLATFORMS: readonly GitPlatform[] = ['github', 'gitlab', 'bitbucket', 'azuredevops', 'gitea']

export class GitPlatformRegistry extends GitPlatformService {
  static inject = ['timer']
  static Config = z.object({
    defaultProvider: z.union(PLATFORMS.map((p) => z.const(p))),
    maxRetries: z.number().default(3),
    backoffMs: z.number().default(1000),
    cacheTtlMs: z.number().default(30000),
    cacheMaxEntries: z.number().default(256),
  })

  readonly config: ResolvedConfig
  private readonly providers = new Map<GitPlatform, GitPlatformProvider>()
  private readonly cache = new Map<string, CacheEntry>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = {
      defaultProvider: config.defaultProvider,
      maxRetries: config.maxRetries ?? 3,
      backoffMs: config.backoffMs ?? 1000,
      cacheTtlMs: config.cacheTtlMs ?? 30000,
      cacheMaxEntries: config.cacheMaxEntries ?? 256,
    }
  }

  registerProvider(provider: GitPlatformProvider): () => void {
    this.providers.set(provider.platform, provider)
    return () => {
      if (this.providers.get(provider.platform) === provider) {
        this.providers.delete(provider.platform)
      }
    }
  }

  private resolveProvider(req: GitPlatformContext): GitPlatformProvider {
    if (req.platform) {
      const provider = this.providers.get(req.platform)
      if (!provider) throw new GitError(`no adapter registered for platform "${req.platform}"`, 'GIT_UNSUPPORTED')
      return provider
    }
    if (req.remoteUrl) {
      for (const provider of this.providers.values()) {
        if (provider.matchesRemote(req.remoteUrl)) return provider
      }
    }
    if (this.config.defaultProvider) {
      const provider = this.providers.get(this.config.defaultProvider)
      if (provider) return provider
    }
    const first = this.providers.values().next().value
    if (first) return first
    throw new GitError('no git platform adapter is registered', 'GIT_UNSUPPORTED')
  }

  private async call<T>(req: GitPlatformContext, read: boolean, cacheKey: string, fn: (provider: GitPlatformProvider) => Promise<T>): Promise<T> {
    const provider = this.resolveProvider(req)
    const key = read && this.config.cacheTtlMs > 0 ? `${provider.platform}:${cacheKey}` : null
    if (key) {
      const hit = this.cache.get(key)
      if (hit && Date.now() - hit.at < this.config.cacheTtlMs) return hit.value as T
    }
    let attempt = 0
    for (;;) {
      try {
        const value = await fn(provider)
        if (key) {
          if (this.cache.size >= this.config.cacheMaxEntries) this.cache.clear()
          this.cache.set(key, { at: Date.now(), value })
        }
        return value
      } catch (error) {
        const code = error instanceof GitError ? error.code : null
        const retriable = code === 'GIT_RATE_LIMITED' || (read && code === 'GIT_NETWORK')
        if (!retriable || attempt >= this.config.maxRetries) throw error
        attempt += 1
        await this.ctx.timer.timeout(this.config.backoffMs * 2 ** (attempt - 1))
      }
    }
  }

  createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult> {
    return this.call(req, false, 'createPullRequest', (p) => p.createPullRequest(req))
  }

  listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]> {
    const key = `listPullRequests:${req.owner}/${req.repo}:${req.state ?? 'open'}:${req.limit ?? 'all'}`
    return this.call(req, true, key, (p) => p.listPullRequests(req))
  }

  mergePullRequest(req: PullRequestMergeRequest): Promise<void> {
    return this.call(req, false, 'mergePullRequest', (p) => p.mergePullRequest(req))
  }

  addReviewComment(req: ReviewCommentRequest): Promise<void> {
    return this.call(req, false, 'addReviewComment', (p) => p.addReviewComment(req))
  }

  listIssues(req: IssueListRequest): Promise<Issue[]> {
    const key = `listIssues:${req.owner}/${req.repo}:${req.state ?? 'open'}:${req.limit ?? 'all'}`
    return this.call(req, true, key, (p) => p.listIssues(req))
  }

  createIssue(req: IssueCreateRequest): Promise<Issue> {
    return this.call(req, false, 'createIssue', (p) => p.createIssue(req))
  }

  createRelease(req: ReleaseCreateRequest): Promise<Release> {
    return this.call(req, false, 'createRelease', (p) => p.createRelease(req))
  }

  listSecurityAlerts(req: SecurityAlertListRequest): Promise<SecurityAlert[]> {
    const key = `listSecurityAlerts:${req.owner}/${req.repo}`
    return this.call(req, true, key, (p) => p.listSecurityAlerts(req))
  }

  listPipelines(req: PipelineListRequest): Promise<PipelineRun[]> {
    const key = `listPipelines:${req.owner}/${req.repo}:${req.branch ?? 'all'}:${req.limit ?? 'all'}`
    return this.call(req, true, key, (p) => p.listPipelines(req))
  }

  getPipelineRun(req: PipelineListRequest & { id: string }): Promise<PipelineRunDetail> {
    const key = `getPipelineRun:${req.owner}/${req.repo}:${req.id}`
    return this.call(req, true, key, (p) => p.getPipelineRun(req))
  }
}

export default GitPlatformRegistry
