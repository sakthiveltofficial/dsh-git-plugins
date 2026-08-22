// Smoke test for @dsh-git/platform + @dsh-git/github.
// Part A: registry mechanics with a fake provider (dispatch, cache, backoff, remote detection).
// Part B: the real GitHub adapter against the public GitHub API (no token; public repos only).
// Run with: node scripts/smoke-platform.mjs
import { GitError } from '../packages/git/core/lib/index.js'
import GitPlatformRegistry from '../packages/git/git-platform/lib/index.js'
import * as github from '../packages/git/git-github/lib/index.js'

let failures = 0
function check(name, condition, extra = '') {
  if (condition) console.log(`ok - ${name}`)
  else { failures += 1; console.log(`FAIL - ${name} ${extra}`) }
}

const fakeTimer = { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) }
const fakeCredentials = { resolve: async () => undefined }

// ── Part A: registry mechanics with a fake provider ─────────────────────────

let githubCalls = 0
const fakeGithubProvider = {
  platform: 'github',
  matchesRemote(url) { return /github\.com/.test(url) },
  async createPullRequest() { githubCalls += 1; return { number: 42, url: 'https://github.com/o/r/pull/42', title: 't', state: 'open' } },
  async listPullRequests() { githubCalls += 1; return [{ number: 1, title: 'a', state: 'open', url: 'u', head: 'h', base: 'b', author: 'x', createdAt: 'd' }] },
  async mergePullRequest() { githubCalls += 1 },
  async addReviewComment() { githubCalls += 1 },
  async listIssues() { githubCalls += 1; return [] },
  async createIssue() { githubCalls += 1; return { number: 1, title: 'i', state: 'open', url: 'u', author: 'x', createdAt: 'd', labels: [] } },
  async createRelease() { githubCalls += 1; return { id: '1', tag: 'v1', name: 'v1', url: 'u', draft: false, prerelease: false } },
  async listSecurityAlerts() { githubCalls += 1; return [] },
  async listPipelines() { githubCalls += 1; return [] },
  async getPipelineRun() { githubCalls += 1; return { id: '1', name: 'r', status: 'completed', conclusion: 'success', url: 'u' } },
}

{
  const registry = new GitPlatformRegistry({ reflect: { provide() {} }, timer: fakeTimer }, { cacheTtlMs: 60000, backoffMs: 5, maxRetries: 2 })
  registry.registerProvider(fakeGithubProvider)

  // remote detection via SCP-style URL
  const viaRemote = await registry.listPullRequests({ remoteUrl: 'git@github.com:owner/repo.git', limit: 1 })
  check('dispatch via remoteUrl detection', viaRemote.length === 1)

  // explicit platform dispatch + read cache: second call must NOT hit the provider
  const before = githubCalls
  await registry.listPullRequests({ platform: 'github', limit: 1 })
  const afterCached = githubCalls
  check('read cache dedupes', afterCached === before, `calls ${before} -> ${afterCached}`)

  // writes are never cached
  const w1 = githubCalls
  await registry.createPullRequest({ platform: 'github', owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' })
  await registry.createPullRequest({ platform: 'github', owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' })
  check('writes bypass cache', githubCalls === w1 + 2)

  // unknown platform → GIT_UNSUPPORTED
  let unsupported = false
  try { await registry.listIssues({ platform: 'gitlab' }) } catch (e) { unsupported = e instanceof GitError && e.code === 'GIT_UNSUPPORTED' }
  check('unknown platform → GIT_UNSUPPORTED', unsupported)

  // backoff retry: first call fails with GIT_RATE_LIMITED, second succeeds
  const flaky = {
    platform: 'gitlab',
    matchesRemote: () => false,
    async listIssues() { if (!this.failed) { this.failed = true; throw new GitError('rate limited', 'GIT_RATE_LIMITED') } return [{ number: 1, title: 'i', state: 'open', url: 'u', author: 'x', createdAt: 'd', labels: [] }] },
    async createPullRequest() { throw new GitError('nope', 'GIT_FAILED') },
    async mergePullRequest() {},
    async addReviewComment() {},
    async createIssue() { throw new GitError('nope', 'GIT_FAILED') },
    async createRelease() { throw new GitError('nope', 'GIT_FAILED') },
    async listSecurityAlerts() { return [] },
    async listPipelines() { return [] },
    async getPipelineRun() { throw new GitError('nope', 'GIT_FAILED') },
    async listPullRequests() { return [] },
  }
  registry.registerProvider(flaky)
  const retried = await registry.listIssues({ platform: 'gitlab' })
  check('backoff retries transient failures', retried.length === 1)

  registry.registerProvider(fakeGithubProvider) // restore
}

// ── Part B: real GitHub adapter against the public API ───────────────────────

{
  const registry = new GitPlatformRegistry({ reflect: { provide() {} }, timer: fakeTimer }, { cacheTtlMs: 0, maxRetries: 1, backoffMs: 5 })
  const ctx = { reflect: { provide() {} }, timer: fakeTimer, credentials: fakeCredentials, gitPlatform: registry }
  const dispose = github.apply(ctx, { tokenRef: undefined })
  check('github adapter registered', dispose === undefined || typeof dispose === 'function')

  try {
    const prs = await registry.listPullRequests({ owner: 'octocat', repo: 'Hello-World', state: 'open', limit: 3 })
    check('GitHub: listPullRequests (public repo)', Array.isArray(prs), JSON.stringify(prs).slice(0, 120))
    console.log('   sample PR:', prs[0] ? `#${prs[0].number} ${prs[0].title}` : '(none)')

    const issues = await registry.listIssues({ owner: 'octocat', repo: 'Hello-World', limit: 3 })
    check('GitHub: listIssues (public repo)', Array.isArray(issues), JSON.stringify(issues).slice(0, 120))

    const runs = await registry.listPipelines({ owner: 'octocat', repo: 'Hello-World', limit: 3 })
    check('GitHub: listPipelines (public repo)', Array.isArray(runs), JSON.stringify(runs).slice(0, 120))

    let alertsOk = false
    try {
      const alerts = await registry.listSecurityAlerts({ owner: 'octocat', repo: 'Hello-World' })
      alertsOk = Array.isArray(alerts) // repo not enrolled without token -> 404 -> []
    } catch (e) {
      alertsOk = e instanceof GitError && e.code === 'GIT_AUTH_FAILED' // 401 without token -> fail loud
    }
    check('GitHub: listSecurityAlerts (empty or auth-fail without token)', alertsOk)

    // no token + write → GIT_AUTH_FAILED (fail loudly)
    let authFailed = false
    try { await registry.createIssue({ owner: 'octocat', repo: 'Hello-World', title: 'x' }) } catch (e) { authFailed = e instanceof GitError && e.code === 'GIT_AUTH_FAILED' }
    check('GitHub: write without token → GIT_AUTH_FAILED', authFailed)
  } catch (e) {
    failures += 1
    console.log('FAIL - GitHub live API error:', e.message)
  }
}

console.log(failures === 0 ? '\nSMOKE OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
