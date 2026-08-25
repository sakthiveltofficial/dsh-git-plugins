/**
 * @dsh-git/gitea — Gitea adapter for `gitPlatform`.
 *
 * Gitea's REST API (v1) is GitHub-shaped, so this adapter closely mirrors the
 * GitHub one. `baseUrl` is REQUIRED (any self-hosted Gitea instance), and auth
 * is `Authorization: token <token>`. Gitea has no Dependabot-style alerts API;
 * `listSecurityAlerts` fails loudly with GIT_UNSUPPORTED.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  gitFetchJson,
  GitError,
  type GitPlatformProvider,
  type Issue,
  type IssueCreateRequest,
  type IssueListRequest,
  type PipelineJob,
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
  /** Env-var REFERENCE for the access token (e.g. `GITEA_TOKEN`). */
  tokenRef?: string
  /** REQUIRED: the Gitea instance base URL, e.g. `https://gitea.example.com`. */
  baseUrl: string
}

export const name = 'git-gitea'
export const inject = ['gitPlatform', 'credentials']

async function authHeaders(ctx: Context, config: Config): Promise<Record<string, string>> {
  const ref = config.tokenRef
  if (!ref) return {}
  const resolved = await ctx.credentials.resolve(credentialRef(ref))
  if (!resolved) return {}
  return { Authorization: `token ${resolved.value}` }
}

export function apply(ctx: Context, config: Config): () => void {
  const base = config.baseUrl.replace(/\/$/, '')
  const host = (() => {
    try { return new URL(base).host } catch { return '' }
  })()
  const hostPattern = host ? new RegExp(`^(?:[a-z][a-z0-9+.-]*:\\/\\/)?(?:[^@/]+@)?${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/:]|$)`, 'i') : null

  async function ga(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const headers = await authHeaders(ctx, config)
    return gitFetchJson(`${base}/api/v1${path}`, { method, headers, body, signal })
  }

  function repoPath(owner: string, repo: string): string {
    return `${owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(repo)}`
  }

  function mapPr(x: any): PullRequestResult {
    return { number: x.number, url: x.html_url ?? x.url ?? '', title: x.title ?? '', state: x.state ?? '' }
  }
  function mapPrSummary(x: any): PullRequestSummary {
    return {
      number: x.number, title: x.title ?? '', state: x.state ?? '', url: x.html_url ?? x.url ?? '',
      head: x.head?.ref ?? '', base: x.base?.ref ?? '', author: x.user?.login ?? '', createdAt: x.created_at ?? '',
    }
  }
  function mapIssue(x: any): Issue {
    return {
      number: x.number, title: x.title ?? '', state: x.state ?? '', url: x.html_url ?? x.url ?? '',
      author: x.user?.login ?? '', createdAt: x.created_at ?? '', body: x.body ?? undefined,
      labels: (x.labels ?? []).map((l: any) => l.name ?? l),
    }
  }
  function mapRelease(x: any): Release {
    return { id: String(x.id), tag: x.tag_name ?? '', name: x.name ?? '', url: x.html_url ?? x.url ?? '', draft: !!x.draft, prerelease: !!x.prerelease }
  }
  function mapRun(x: any): PipelineRun {
    return { id: String(x.id), name: x.name ?? x.display_title ?? String(x.id), status: x.status ?? '', conclusion: x.conclusion, url: x.html_url ?? x.url ?? '', branch: x.head_branch, createdAt: x.created_at }
  }
  function mapJob(x: any): PipelineJob {
    return { id: String(x.id), name: x.name ?? '', status: x.status ?? '', conclusion: x.conclusion }
  }

  const provider: GitPlatformProvider = {
    platform: 'gitea',
    matchesRemote(url) {
      if (!hostPattern) return false
      return hostPattern.test(url)
    },

    async createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult> {
      const data = await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/pulls`, {
        title: req.title, head: req.head, base: req.base, body: req.body,
      }, req.signal)
      return mapPr(data)
    },

    async listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]> {
      const query = new URLSearchParams({ state: req.state ?? 'open', limit: String(req.limit ?? 30) }).toString()
      const data = await ga('GET', `/repos/${repoPath(req.owner, req.repo)}/pulls?${query}`, undefined, req.signal)
      return (data as any[]).map(mapPrSummary)
    },

    async mergePullRequest(req: PullRequestMergeRequest): Promise<void> {
      const doMethod = req.method === 'squash' ? 'squash' : req.method === 'rebase' ? 'rebase' : 'merge'
      try {
        await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/pulls/${req.number}/merge`, { Do: doMethod }, req.signal)
      } catch (error) {
        if (error instanceof GitError && (error.status === 404 || error.status === 405 || error.status === 409)) {
          throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error })
        }
        throw error
      }
    },

    async addReviewComment(req: ReviewCommentRequest): Promise<void> {
      await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/pulls/${req.pullNumber}/comments`, { body: req.body }, req.signal)
    },

    async listIssues(req: IssueListRequest): Promise<Issue[]> {
      const query = new URLSearchParams({ state: req.state ?? 'open', limit: String(req.limit ?? 30) }).toString()
      const data = await ga('GET', `/repos/${repoPath(req.owner, req.repo)}/issues?${query}`, undefined, req.signal)
      return (data as any[]).filter((x) => !x.pull_request).map(mapIssue)
    },

    async createIssue(req: IssueCreateRequest): Promise<Issue> {
      // Gitea labels are numeric ids on create; passing names is unreliable, so labels are omitted.
      const data = await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/issues`, {
        title: req.title, body: req.body,
      }, req.signal)
      return mapIssue(data)
    },

    async createRelease(req: ReleaseCreateRequest): Promise<Release> {
      const data = await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/releases`, {
        tag_name: req.tag, name: req.name, body: req.body, draft: req.draft ?? false, prerelease: req.prerelease ?? false,
      }, req.signal)
      return mapRelease(data)
    },

    async listSecurityAlerts(_req: SecurityAlertListRequest): Promise<SecurityAlert[]> {
      throw new GitError('Gitea does not expose Dependabot-style security alerts; not supported by this adapter', 'GIT_UNSUPPORTED')
    },

    async listPipelines(req: PipelineListRequest): Promise<PipelineRun[]> {
      // Gitea Actions API (Gitea >= 1.21 with Actions enabled) mirrors GitHub's shapes.
      const query = new URLSearchParams({ limit: String(req.limit ?? 30) })
      if (req.branch) query.set('branch', req.branch)
      const data = await ga('GET', `/repos/${repoPath(req.owner, req.repo)}/actions/runs?${query.toString()}`, undefined, req.signal) as any
      return ((data?.workflow_runs ?? (Array.isArray(data) ? data : [])) as any[]).map(mapRun)
    },

    async getPipelineRun(req: PipelineListRequest & { id: string }): Promise<PipelineRunDetail> {
      const base = `/repos/${repoPath(req.owner, req.repo)}/actions/runs/${encodeURIComponent(req.id)}`
      const run = await ga('GET', base, undefined, req.signal) as any
      let jobs: PipelineJob[] = []
      try {
        const jobData = await ga('GET', `${base}/jobs`, undefined, req.signal) as any
        jobs = ((jobData?.jobs ?? (Array.isArray(jobData) ? jobData : [])) as any[]).map(mapJob)
      } catch {
        // jobs are best-effort
      }
      return { id: String(run.id), name: run.name ?? run.display_title ?? String(run.id), status: run.status ?? '', conclusion: run.conclusion, url: run.html_url ?? run.url ?? '', jobs }
    },
  }

  return ctx.gitPlatform.registerProvider(provider)
}

// Attach inject directly on the function — Cordis reads plugin.inject (the
// function's own property) not the module-level `export const inject`.
apply.inject = inject

export default apply
