/**
 * @dsh-git/azuredevops — Azure DevOps adapter for `gitPlatform`.
 *
 * Owner is `organization/project` (as parsed from `dev.azure.com/org/project/_git/repo`
 * remotes) and is split into separate URL segments — never encoded as one path.
 * Auth is HTTP Basic with an empty username and the PAT as the password.
 * `api-version=7.1` is stamped on every call. Issues map to Work Items
 * (Wiql + $Issue); releases and security alerts are unsupported and fail
 * loudly with GIT_UNSUPPORTED.
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
  /** Env-var REFERENCE for the Personal Access Token (e.g. `AZURE_DEVOPS_PAT`). */
  patRef?: string
  /** Organization base URL (default `https://dev.azure.com`). */
  baseUrl?: string
  /** REST API version (default `7.1`). */
  apiVersion?: string
}

export const name = 'git-azuredevops'
export const inject = ['gitPlatform', 'credentials']

const AZURE_HOSTS = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?(?:dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)([/:]|$)/i

async function authHeaders(ctx: Context, config: Config): Promise<Record<string, string>> {
  const ref = config.patRef
  if (!ref) return {}
  const resolved = await ctx.credentials.resolve(credentialRef(ref))
  if (!resolved) return {}
  const token = Buffer.from(`:${resolved.value}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** `org/project` → `org/project` with each segment encoded separately. */
function orgProjectPath(owner: string): string {
  return owner.split('/').map(encodeURIComponent).join('/')
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const base = (config.baseUrl ?? 'https://dev.azure.com').replace(/\/$/, '')
  const apiVersion = config.apiVersion ?? '7.1'

  async function az(method: string, path: string, body: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<unknown> {
    const auth = await authHeaders(ctx, config)
    return gitFetchJson(`${base}${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`, {
      method, headers: { ...auth, ...headers }, body, signal,
    })
  }

  function repoPath(owner: string, repo: string): string {
    return `${orgProjectPath(owner)}/_apis/git/repositories/${encodeURIComponent(repo)}`
  }

  function prState(x: string): string {
    if (x === 'active') return 'open'
    if (x === 'completed' || x === 'abandoned') return 'closed'
    return x
  }

  function mapPr(x: any): PullRequestResult {
    return { number: x.pullRequestId, url: x.url ?? '', title: x.title ?? '', state: prState(x.status ?? '') }
  }
  function mapPrSummary(x: any): PullRequestSummary {
    return {
      number: x.pullRequestId, title: x.title ?? '', state: prState(x.status ?? ''), url: x.url ?? '',
      head: (x.sourceRefName ?? '').replace(/^refs\/heads\//, ''), base: (x.targetRefName ?? '').replace(/^refs\/heads\//, ''),
      author: x.createdBy?.displayName ?? '', createdAt: x.creationDate ?? '',
    }
  }
  function mapRun(x: any): PipelineRun {
    return {
      id: String(x.id), name: x.buildNumber ?? String(x.id), status: x.status ?? '',
      conclusion: x.result ?? undefined, url: x._links?.web?.href ?? x.url ?? '', branch: (x.sourceBranch ?? '').replace(/^refs\/heads\//, ''),
    }
  }
  function mapJob(x: any): PipelineJob {
    return { id: String(x.id ?? x.recordId), name: x.name ?? '', status: (x.status ?? '').toLowerCase(), conclusion: (x.result ?? '').toLowerCase() }
  }

  const provider: GitPlatformProvider = {
    platform: 'azuredevops',
    matchesRemote(url) {
      return AZURE_HOSTS.test(url)
    },

    async createPullRequest(req: PullRequestCreateRequest): Promise<PullRequestResult> {
      const data = await az('POST', `/${repoPath(req.owner, req.repo)}/pullrequests`, {
        title: req.title, description: req.body,
        sourceRefName: `refs/heads/${req.head}`, targetRefName: `refs/heads/${req.base}`,
      }, req.signal)
      return mapPr(data)
    },

    async listPullRequests(req: PullRequestListRequest): Promise<PullRequestSummary[]> {
      const status = req.state === 'all' ? 'all' : req.state ?? 'active'
      const data = await az('GET', `/${repoPath(req.owner, req.repo)}/pullrequests?searchCriteria.status=${status}&$top=${req.limit ?? 30}`, undefined, req.signal) as any
      return (data?.value ?? []).map(mapPrSummary)
    },

    async mergePullRequest(req: PullRequestMergeRequest): Promise<void> {
      const mergeStrategy = req.method === 'squash' ? 'squash' : req.method === 'rebase' ? 'rebase' : 'noFastForward'
      try {
        await az('PATCH', `/${repoPath(req.owner, req.repo)}/pullrequests/${req.number}`, {
          status: 'completed', completionOptions: { mergeStrategy },
        }, req.signal)
      } catch (error) {
        if (error instanceof GitError && (error.status === 409 || error.status === 400)) {
          throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error })
        }
        throw error
      }
    },

    async addReviewComment(req: ReviewCommentRequest): Promise<void> {
      await az('POST', `/${repoPath(req.owner, req.repo)}/pullrequests/${req.pullNumber}/threads`, {
        comments: [{ content: req.body }], status: 'active',
      }, req.signal)
    },

    async listIssues(req: IssueListRequest): Promise<Issue[]> {
      const project = req.owner.split('/').at(-1) ?? req.owner
      const query = `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.WorkItemType] = 'Issue' ORDER BY [System.CreatedDate] DESC`
      const wiql = await az('POST', `/${orgProjectPath(req.owner)}/_apis/wit/wiql`, { query }, req.signal) as any
      const ids = (wiql?.workItems ?? []).slice(0, req.limit ?? 30).map((w: any) => w.id)
      if (ids.length === 0) return []
      const data = await az('GET', `/${orgProjectPath(req.owner)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.CreatedDate,System.CreatedBy`, undefined, req.signal) as any
      return (data?.value ?? []).map((x: any): Issue => {
        const f = x.fields ?? {}
        return {
          number: x.id, title: f['System.Title'] ?? '', state: (f['System.State'] ?? '').toLowerCase(), url: `${base}/${req.owner}/_workitems/edit/${x.id}`,
          author: f['System.CreatedBy']?.displayName ?? '', createdAt: f['System.CreatedDate'] ?? '', body: undefined, labels: [],
        }
      })
    },

    async createIssue(req: IssueCreateRequest): Promise<Issue> {
      const ops: any[] = [
        { op: 'add', path: '/fields/System.Title', value: req.title },
        ...(req.body ? [{ op: 'add', path: '/fields/System.Description', value: req.body }] : []),
      ]
      const data = await az('POST', `/${orgProjectPath(req.owner)}/_apis/wit/workitems/$Issue`, ops, req.signal, { 'Content-Type': 'application/json-patch+json' }) as any
      const f = data.fields ?? {}
      return {
        number: data.id, title: f['System.Title'] ?? req.title, state: (f['System.State'] ?? 'new').toLowerCase(), url: `${base}/${req.owner}/_workitems/edit/${data.id}`,
        author: f['System.CreatedBy']?.displayName ?? '', createdAt: f['System.CreatedDate'] ?? '', body: req.body, labels: [],
      }
    },

    async createRelease(_req: ReleaseCreateRequest): Promise<Release> {
      throw new GitError('Azure DevOps releases require a Release pipeline; not supported by this adapter', 'GIT_UNSUPPORTED')
    },

    async listSecurityAlerts(_req: SecurityAlertListRequest): Promise<SecurityAlert[]> {
      throw new GitError('Azure DevOps does not expose repository security alerts; not supported by this adapter', 'GIT_UNSUPPORTED')
    },

    async listPipelines(req: PipelineListRequest): Promise<PipelineRun[]> {
      const data = await az('GET', `/${orgProjectPath(req.owner)}/_apis/build/builds?$top=${req.limit ?? 30}&queryOrder=queueTimeDescending`, undefined, req.signal) as any
      const values: any[] = data.value ?? []
      const filtered = values.filter((x) => !req.branch || (x.sourceBranch ?? '').replace(/^refs\/heads\//, '') === req.branch)
      return filtered.map(mapRun)
    },

    async getPipelineRun(req: PipelineListRequest & { id: string }): Promise<PipelineRunDetail> {
      const run = await az('GET', `/${orgProjectPath(req.owner)}/_apis/build/builds/${encodeURIComponent(req.id)}`, undefined, req.signal) as any
      let jobs: PipelineJob[] = []
      try {
        const timeline = await az('GET', `/${orgProjectPath(req.owner)}/_apis/build/builds/${encodeURIComponent(req.id)}/timeline`, undefined, req.signal) as any
        jobs = (timeline?.records ?? []).filter((r: any) => r.type === 'Task').map(mapJob)
      } catch {
        // timeline is best-effort
      }
      return {
        id: String(run.id), name: run.buildNumber ?? String(run.id), status: run.status ?? '', conclusion: run.result,
        url: run._links?.web?.href ?? run.url ?? '', jobs,
      }
    },
  }

  return ctx.gitPlatform.registerProvider(provider)
}

export default apply
