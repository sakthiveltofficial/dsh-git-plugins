/**
 * @dsh-git/github — GitHub adapter for `gitPlatform`.
 *
 * The reference implementation: REST endpoints against `api.github.com`
 * through Node's global fetch, every response normalized into the seam's
 * vocabulary. Tokens are optional (public repos work anonymously) and resolved
 * per operation through `ctx.credentials` from the configured env-var
 * reference — never cached, never inlined.
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
  /** Env-var REFERENCE for the token (e.g. `GITHUB_TOKEN`), resolved per operation. */
  tokenRef?: string
  /** API base URL (default `https://api.github.com`). */
  baseUrl?: string
}

const GITHUB_REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com([/:]|$)/i

export const name = 'git-github'
export const inject = ['gitPlatform', 'credentials']

function enc(value: string): string {
  return encodeURIComponent(value)
}

async function authHeaders(ctx: Context, config: Config): Promise<Record<string, string>> {
  const ref = config.tokenRef
  if (!ref) return {}
  const resolved = await ctx.credentials.resolve(credentialRef(ref))
  if (!resolved) return {}
  return { Authorization: `Bearer ${resolved.value}` }
}

async function gh(ctx: Context, config: Config, method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const headers = await authHeaders(ctx, config)
  return gitFetchJson(`${config.baseUrl ?? 'https://api.github.com'}${path}`, { method, headers, body, signal })
}

// ── normalization ────────────────────────────────────────────────────────────

function mapPr(x: any): PullRequestResult {
  return { number: x.number, url: x.html_url ?? x.url ?? '', title: x.title ?? '', state: x.state ?? '' }
}
function mapPrSummary(x: any): PullRequestSummary {
  return {
    number: x.number, title: x.title ?? '', state: x.state ?? '', url: x.html_url ?? x.url ?? '',
    head: x.head?.ref ?? '', base: x.base?.ref ?? '', author: x.user?.login ?? '',
    createdAt: x.created_at ?? '', mergeable: x.mergeable,
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
function mapAlert(x: any): SecurityAlert {
  return {
    id: String(x.number ?? x.ghsa_id ?? x.id), severity: x.security_severity_level ?? x.severity ?? 'unknown',
    package: x.dependency?.package?.name ?? '', advisory: x.security_advisory?.summary ?? '',
    state: x.state ?? '', url: x.html_url,
  }
}
function mapRun(x: any): PipelineRun {
  return { id: String(x.id), name: x.name ?? x.display_title ?? '', status: x.status ?? '', conclusion: x.conclusion, url: x.html_url ?? x.url ?? '', branch: x.head_branch, createdAt: x.created_at }
}
function mapJob(x: any): PipelineJob {
  return { id: String(x.id), name: x.name ?? '', status: x.status ?? '', conclusion: x.conclusion }
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const provider: GitPlatformProvider = {
    platform: 'github',
    matchesRemote(url) {
      return GITHUB_REMOTE.test(url)
    },

    async createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult> {
      const data = await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls`, {
        title: req.title, head: req.head, base: req.base, body: req.body,
      }, req.signal)
      return mapPr(data)
    },

    async listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]> {
      const query = new URLSearchParams({
        state: req.state ?? 'open',
        per_page: String(req.limit ?? 30),
      }).toString()
      const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls?${query}`, undefined, req.signal)
      return ((data as any[] | null) ?? []).map(mapPrSummary)
    },

    async mergePullRequest(req: PullRequestMergeRequest): Promise<void> {
      try {
        await gh(ctx, config, 'PUT', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls/${req.number}/merge`, {
          merge_method: req.method ?? 'merge',
        }, req.signal)
      } catch (error) {
        if (error instanceof GitError && error.status === 409) {
          throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error })
        }
        throw error
      }
    },

    async addReviewComment(req: ReviewCommentRequest): Promise<void> {
      await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls/${req.pullNumber}/comments`, {
        body: req.body,
      }, req.signal)
    },

    async listIssues(req: IssueListRequest): Promise<Issue[]> {
      const query = new URLSearchParams({
        state: req.state ?? 'open',
        per_page: String(req.limit ?? 30),
      }).toString()
      const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/issues?${query}`, undefined, req.signal)
      return ((data as any[] | null) ?? [])
        .filter((x) => !x.pull_request) // GitHub's /issues endpoint also returns PRs
        .map(mapIssue)
    },

    async createIssue(req: IssueCreateRequest): Promise<Issue> {
      const data = await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/issues`, {
        title: req.title, body: req.body, labels: req.labels,
      }, req.signal)
      return mapIssue(data)
    },

    async createRelease(req: ReleaseCreateRequest): Promise<Release> {
      const data = await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/releases`, {
        tag_name: req.tag, name: req.name, body: req.body, draft: req.draft ?? false, prerelease: req.prerelease ?? false,
      }, req.signal)
      return mapRelease(data)
    },

    async listSecurityAlerts(req: SecurityAlertListRequest): Promise<SecurityAlert[]> {
      try {
        const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/dependabot/alerts?per_page=100`, undefined, req.signal)
        return ((data as any[] | null) ?? []).map(mapAlert)
      } catch (error) {
        // 404 = repo not enrolled / alerts unavailable; report an empty list rather than an error.
        if (error instanceof GitError && error.status === 404) return []
        throw error
      }
    },

    async listPipelines(req: PipelineListRequest): Promise<PipelineRun[]> {
      const query = new URLSearchParams({ per_page: String(req.limit ?? 30) })
      if (req.branch) query.set('branch', req.branch)
      const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/actions/runs?${query.toString()}`, undefined, req.signal)
      return ((data as any)?.workflow_runs ?? []).map(mapRun)
    },

    async getPipelineRun(req: PipelineListRequest & { id: string }): Promise<PipelineRunDetail> {
      const base = `/repos/${enc(req.owner)}/${enc(req.repo)}/actions/runs/${enc(req.id)}`
      const run = await gh(ctx, config, 'GET', base, undefined, req.signal) as any
      let jobs: PipelineJob[] = []
      try {
        const jobData = await gh(ctx, config, 'GET', `${base}/jobs`, undefined, req.signal) as any
        jobs = (jobData.jobs ?? []).map(mapJob)
      } catch {
        // jobs are best-effort; a missing jobs list should not fail the run detail
      }
      return { id: String(run.id), name: run.name ?? run.display_title ?? '', status: run.status ?? '', conclusion: run.conclusion, url: run.html_url ?? run.url ?? '', jobs }
    },
  }

  return ctx.gitPlatform.registerProvider(provider)
}

// Attach inject as a property on the function so Cordis reads it correctly
// regardless of whether it calls apply() or new apply() (isConstructor returns
// true for plain functions that have a .prototype, so plugin.inject must be set
// directly on the function — the module-level `export const inject` alone is not
// sufficient).
apply.inject = inject

export default apply
