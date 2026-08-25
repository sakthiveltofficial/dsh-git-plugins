/**
 * @dsh-git/gitlab — GitLab adapter for `gitPlatform`.
 *
 * REST v4 (`{baseUrl}/api/v4`). GitLab identifies projects by URL-encoded path
 * (`group/subgroup/repo` → `group%2Fsubgroup%2Frepo`), so owner segments are
 * encoded as one path, not per segment. Auth is the `PRIVATE-TOKEN` header,
 * resolved per operation through `ctx.credentials`.
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
  /** Env-var REFERENCE for the private token (e.g. `GITLAB_TOKEN`). */
  tokenRef?: string
  /** Host base URL, e.g. `https://gitlab.com` or a self-hosted instance. */
  baseUrl?: string
}

export const name = 'git-gitlab'
export const inject = ['gitPlatform', 'credentials']

async function authHeaders(ctx: Context, config: Config): Promise<Record<string, string>> {
  const ref = config.tokenRef
  if (!ref) return {}
  const resolved = await ctx.credentials.resolve(credentialRef(ref))
  if (!resolved) return {}
  return { 'PRIVATE-TOKEN': resolved.value }
}

function matchesGitlabHost(config: Config, url: string): boolean {
  const host = (() => {
    try { return new URL(config.baseUrl ?? 'https://gitlab.com').host } catch { return 'gitlab.com' }
  })()
  return new RegExp(`^(?:[a-z][a-z0-9+.-]*:\\/\\/)?(?:[^@/]+@)?${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/:]|$)`, 'i').test(url)
}

/** GitLab project path: owner/repo URL-encoded as ONE path segment. */
function projectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`)
}

async function gl(ctx: Context, config: Config, method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const headers = await authHeaders(ctx, config)
  const base = (config.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '')
  return gitFetchJson(`${base}/api/v4${path}`, { method, headers, body, signal })
}

// ── normalization ────────────────────────────────────────────────────────────

function mapPr(x: any): PullRequestResult {
  return { number: x.iid ?? x.id, url: x.web_url ?? '', title: x.title ?? '', state: x.state ?? '' }
}
function mapPrSummary(x: any): PullRequestSummary {
  return {
    number: x.iid ?? x.id, title: x.title ?? '', state: x.state ?? '', url: x.web_url ?? '',
    head: x.source_branch ?? '', base: x.target_branch ?? '', author: x.author?.username ?? '',
    createdAt: x.created_at ?? '', mergeable: x.detailed_merge_status === 'mergeable',
  }
}
function mapIssue(x: any): Issue {
  return {
    number: x.iid ?? x.id, title: x.title ?? '', state: x.state ?? '', url: x.web_url ?? '',
    author: x.author?.username ?? '', createdAt: x.created_at ?? '', body: x.description ?? undefined,
    labels: (x.labels ?? []).map(String),
  }
}
function mapRelease(x: any): Release {
  return { id: String(x.tag_name ?? x.id), tag: x.tag_name ?? '', name: x.name ?? '', url: x._links?.self ?? '', draft: false, prerelease: false }
}
function mapPipeline(x: any, base: string, owner: string, repo: string): PipelineRun {
  return { id: String(x.id), name: x.ref ?? String(x.id), status: x.status ?? '', conclusion: x.status, url: `${base}/${owner}/${repo}/-/pipelines/${x.id}`, branch: x.ref, createdAt: x.created_at }
}
function mapJob(x: any): PipelineJob {
  return { id: String(x.id), name: x.name ?? '', status: x.status ?? '' }
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const base = (config.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '')
  const provider: GitPlatformProvider = {
    platform: 'gitlab',
    matchesRemote(url) {
      return matchesGitlabHost(config, url)
    },

    async createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult> {
      const data = await gl(ctx, config, 'POST', `/projects/${projectPath(req.owner, req.repo)}/merge_requests`, {
        title: req.title, source_branch: req.head, target_branch: req.base, description: req.body,
      }, req.signal)
      return mapPr(data)
    },

    async listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]> {
      const query = new URLSearchParams({ state: req.state === 'all' ? 'all' : req.state ?? 'opened', per_page: String(req.limit ?? 30) }).toString()
      const data = await gl(ctx, config, 'GET', `/projects/${projectPath(req.owner, req.repo)}/merge_requests?${query}`, undefined, req.signal)
      return ((data as any[] | null) ?? []).map(mapPrSummary)
    },

    async mergePullRequest(req: PullRequestMergeRequest): Promise<void> {
      try {
        await gl(ctx, config, 'PUT', `/projects/${projectPath(req.owner, req.repo)}/merge_requests/${req.number}/merge`, {
          squash: req.method === 'squash',
        }, req.signal)
      } catch (error) {
        if (error instanceof GitError && (error.status === 405 || error.status === 406 || error.status === 409)) {
          throw new GitError(`merge request !${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error })
        }
        throw error
      }
    },

    async addReviewComment(req: ReviewCommentRequest): Promise<void> {
      await gl(ctx, config, 'POST', `/projects/${projectPath(req.owner, req.repo)}/merge_requests/${req.pullNumber}/notes`, {
        body: req.body,
      }, req.signal)
    },

    async listIssues(req: IssueListRequest): Promise<Issue[]> {
      const query = new URLSearchParams({ state: req.state === 'all' ? 'all' : req.state ?? 'opened', per_page: String(req.limit ?? 30) }).toString()
      const data = await gl(ctx, config, 'GET', `/projects/${projectPath(req.owner, req.repo)}/issues?${query}`, undefined, req.signal)
      return ((data as any[] | null) ?? []).map(mapIssue)
    },

    async createIssue(req: IssueCreateRequest): Promise<Issue> {
      const data = await gl(ctx, config, 'POST', `/projects/${projectPath(req.owner, req.repo)}/issues`, {
        title: req.title, description: req.body, labels: req.labels?.join(',') ?? undefined,
      }, req.signal)
      return mapIssue(data)
    },

    async createRelease(req: ReleaseCreateRequest): Promise<Release> {
      const data = await gl(ctx, config, 'POST', `/projects/${projectPath(req.owner, req.repo)}/releases`, {
        tag_name: req.tag, name: req.name, description: req.body,
      }, req.signal)
      return mapRelease(data)
    },

    async listSecurityAlerts(req: SecurityAlertListRequest): Promise<SecurityAlert[]> {
      try {
        const data = await gl(ctx, config, 'GET', `/projects/${projectPath(req.owner, req.repo)}/vulnerability_findings?report_type=dependency_scanning&per_page=100`, undefined, req.signal)
        return ((data as any[] | null) ?? []).map((x: any) => ({
          id: String(x.id), severity: x.severity ?? 'unknown',
          package: x.location?.dependency?.name ?? x.location?.file ?? '', advisory: x.title ?? '',
          state: x.state ?? 'detected', url: x.location?.blob_path ? `${base}${x.location.blob_path}` : undefined,
        }))
      } catch (error) {
        if (error instanceof GitError && error.status === 404) return [] // no dependency scanning enabled
        throw error
      }
    },

    async listPipelines(req: PipelineListRequest): Promise<PipelineRun[]> {
      const query = new URLSearchParams({ per_page: String(req.limit ?? 30) })
      if (req.branch) query.set('ref', req.branch)
      const data = await gl(ctx, config, 'GET', `/projects/${projectPath(req.owner, req.repo)}/pipelines?${query.toString()}`, undefined, req.signal)
      return (data as any[]).map((x) => mapPipeline(x, base, req.owner, req.repo))
    },

    async getPipelineRun(req: PipelineListRequest & { id: string }): Promise<PipelineRunDetail> {
      const path = `/projects/${projectPath(req.owner, req.repo)}/pipelines/${encodeURIComponent(req.id)}`
      const run = await gl(ctx, config, 'GET', path, undefined, req.signal) as any
      let jobs: PipelineJob[] = []
      try {
        const jobData = await gl(ctx, config, 'GET', `${path}/jobs`, undefined, req.signal) as any
        jobs = (jobData ?? []).map(mapJob)
      } catch {
        // jobs are best-effort
      }
      return { id: String(run.id), name: run.ref ?? String(run.id), status: run.status ?? '', conclusion: run.status, url: `${base}/${req.owner}/${req.repo}/-/pipelines/${run.id}`, jobs }
    },
  }

  return ctx.gitPlatform.registerProvider(provider)
}

// Attach inject directly on the function — Cordis reads plugin.inject (the
// function's own property) not the module-level `export const inject`.
apply.inject = inject

export default apply
