// Smoke test for all five platform adapters (no credentials needed).
// Part 1: parseRemote unit checks.
// Part 2: remote-URL detection + URL construction, proven by the error the
//         live (public) endpoint returns for a nonexistent repo: the right
//         adapter must have been chosen AND built the expected URL.
// Part 3: honest GIT_UNSUPPORTED paths (no network).
// Run with: node scripts/smoke-adapters.mjs
import { GitError, parseRemote } from '../packages/git/core/lib/index.js'
import GitPlatformRegistry from '../packages/git/git-platform/lib/index.js'
import * as github from '../packages/git/git-github/lib/index.js'
import * as gitlab from '../packages/git/git-gitlab/lib/index.js'
import * as bitbucket from '../packages/git/git-bitbucket/lib/index.js'
import * as azure from '../packages/git/git-azuredevops/lib/index.js'
import * as gitea from '../packages/git/git-gitea/lib/index.js'

let failures = 0
function check(name, condition, extra = '') {
  if (condition) console.log(`ok - ${name}`)
  else { failures += 1; console.log(`FAIL - ${name} ${extra}`) }
}

// ── Part 1: parseRemote ──────────────────────────────────────────────────────

{
  const cases = [
    ['git@github.com:owner/repo.git', 'github.com', 'owner', 'repo'],
    ['https://gitlab.com/group/sub/repo.git', 'gitlab.com', 'group/sub', 'repo'],
    ['ssh://git@bitbucket.org/ws/repo', 'bitbucket.org', 'ws', 'repo'],
    ['https://dev.azure.com/org/project/_git/repo', 'dev.azure.com', 'org/project', 'repo'],
    ['https://gitea.example.com:8443/owner/repo.git', 'gitea.example.com', 'owner', 'repo'],
  ]
  for (const [url, host, owner, repo] of cases) {
    const p = parseRemote(url)
    check(`parseRemote ${url}`, p !== null && p.host === host && p.owner === owner && p.repo === repo, JSON.stringify(p))
  }
  check('parseRemote rejects garbage', parseRemote('not a url') === null)
}

// ── Part 2: remote detection + URL construction per adapter ──────────────────

const fakeTimer = { timeout: () => new Promise((r) => setTimeout(r, 1)) }
const fakeCredentials = { resolve: async () => ({ value: 'fake-token', source: 'env' }) }

{
  const reg = new GitPlatformRegistry({ reflect: { provide() {} }, timer: fakeTimer }, { maxRetries: 0, backoffMs: 1, cacheTtlMs: 0 })
  const ctx = { reflect: { provide() {} }, timer: fakeTimer, credentials: fakeCredentials, gitPlatform: reg }
  github.apply(ctx, { tokenRef: 'GITHUB_TOKEN' })
  gitlab.apply(ctx, { tokenRef: 'GITLAB_TOKEN' })
  bitbucket.apply(ctx, { username: 'u', appPasswordRef: 'BITBUCKET_APP_PASSWORD' })
  // azure: matchesRemote is host-based (dev.azure.com) but baseUrl is pointed at a
  // dead port so the URL shape is verified deterministically via connection-refused.
  azure.apply(ctx, { patRef: 'AZURE_DEVOPS_PAT', baseUrl: 'http://127.0.0.1:1' })
  gitea.apply(ctx, { tokenRef: 'GITEA_TOKEN', baseUrl: 'https://gitea.example.com' })

  const cases = [
    ['github', 'git@github.com:owner/repo.git', /repos\/o\/r\/pulls/],
    ['gitlab', 'https://gitlab.com/group/sub/repo.git', /api\/v4\/projects\//],
    ['bitbucket', 'https://user@bitbucket.org/ws/repo.git', /repositories\/o\/r\/pullrequests/],
    ['azuredevops', 'https://dev.azure.com/org/project/_git/repo', /_apis\/git\/repositories\/r\/pullrequests/],
    ['gitea', 'https://gitea.example.com/owner/repo.git', /api\/v1\/repos\/o\/r\/pulls/],
  ]
  for (const [platform, remoteUrl, fragment] of cases) {
    try {
      await reg.listPullRequests({ remoteUrl, owner: 'o', repo: 'r', limit: 1 })
      check(`adapter ${platform}: dispatched via remote detection`, false, '(no error raised)')
    } catch (e) {
      const msg = e.message ?? String(e)
      check(`adapter ${platform}: routed by remote + URL shape`, fragment.test(msg), `${platform} → ${msg.slice(0, 140)}`)
    }
  }
}

// ── Part 3: honest unsupported paths ─────────────────────────────────────────

{
  const reg = new GitPlatformRegistry({ reflect: { provide() {} }, timer: fakeTimer }, { maxRetries: 0, backoffMs: 1, cacheTtlMs: 0 })
  const ctx = { reflect: { provide() {} }, timer: fakeTimer, credentials: fakeCredentials, gitPlatform: reg }
  github.apply(ctx, {})
  bitbucket.apply(ctx, { username: 'u', appPasswordRef: 'X' })
  azure.apply(ctx, { patRef: 'X' })
  gitea.apply(ctx, { baseUrl: 'http://127.0.0.1:1' })

  const unsupported = [
    ['bitbucket listSecurityAlerts', () => reg.listSecurityAlerts({ platform: 'bitbucket', owner: 'o', repo: 'r' })],
    ['azure createRelease', () => reg.createRelease({ platform: 'azuredevops', owner: 'org/project', repo: 'r', tag: 'v1' })],
    ['azure listSecurityAlerts', () => reg.listSecurityAlerts({ platform: 'azuredevops', owner: 'org/project', repo: 'r' })],
    ['gitea listSecurityAlerts', () => reg.listSecurityAlerts({ platform: 'gitea', owner: 'o', repo: 'r' })],
  ]
  for (const [name, fn] of unsupported) {
    try {
      await fn()
      check(`${name} → GIT_UNSUPPORTED`, false, '(no error raised)')
    } catch (e) {
      check(`${name} → GIT_UNSUPPORTED`, e instanceof GitError && e.code === 'GIT_UNSUPPORTED', e.message)
    }
  }
}

console.log(failures === 0 ? '\nSMOKE OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
