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
import { Service } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** Typed git error; route on `code`, never by parsing `message`. */
export class GitError extends HarnessError {
    constructor(message, code, options) {
        super(message, code, options);
        this.code = code;
        this.status = options?.status;
    }
}
/**
 * One JSON HTTP request through Node's global fetch with the seam's error
 * mapping: abort → GIT_ABORTED, transport failure → GIT_NETWORK, 401 →
 * GIT_AUTH_FAILED, 429/403 → GIT_RATE_LIMITED, other non-2xx → GIT_FAILED.
 */
export async function gitFetchJson(url, options = {}) {
    let response;
    try {
        response = await fetch(url, {
            method: options.method ?? 'GET',
            headers: {
                Accept: 'application/json',
                ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers,
            },
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal: options.signal,
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new GitError('request aborted', 'GIT_ABORTED', { cause: error });
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new GitError(`network request to ${url} failed: ${detail}`, 'GIT_NETWORK', { cause: error });
    }
    if (response.status === 401)
        throw new GitError(`authentication failed (HTTP 401) for ${url}`, 'GIT_AUTH_FAILED', { status: 401 });
    if (response.status === 429) {
        throw new GitError(`rate limited (HTTP 429) for ${url}`, 'GIT_RATE_LIMITED', { status: 429 });
    }
    if (response.status === 403) {
        // GitHub reports exhausted rate limits as 403 with x-ratelimit-remaining: 0;
        // other hosts use 403 for permission/scope denial.
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0')
            throw new GitError(`rate limited (HTTP 403) for ${url}`, 'GIT_RATE_LIMITED', { status: 403 });
        throw new GitError(`forbidden (HTTP 403) for ${url}: the credential may lack the required scope`, 'GIT_AUTH_FAILED', { status: 403 });
    }
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new GitError(`request to ${url} failed (HTTP ${response.status}): ${detail.slice(0, 300)}`, 'GIT_FAILED', { status: response.status });
    }
    if (response.status === 204)
        return null;
    return response.json().catch(() => null);
}
/**
 * Parse a git remote URL (https, ssh, or SCP-style) into host/owner/repo.
 * Supports Azure DevOps `_git` layout and multi-segment owners.
 */
export function parseRemote(url) {
    const trimmed = url.trim();
    if (!trimmed)
        return null;
    const adoSplit = trimmed.split('/_git/');
    if (adoSplit.length === 2) {
        const head = adoSplit[0].replace(/^https?:\/\//, '');
        const hostMatch = head.match(/^([^/]+)/);
        if (!hostMatch)
            return null;
        return { host: hostMatch[1], owner: head.split('/').slice(1).join('/'), repo: adoSplit[1].replace(/\.git$/, '') };
    }
    const match = trimmed.match(/^(?:https?:\/\/|ssh:\/\/[^@/]+@|git@)?([^/:]+)(?::\d+)?(?::|\/)(.+)$/);
    if (!match)
        return null;
    const segments = match[2].replace(/\.git$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
    if (segments.length < 2)
        return null;
    return {
        host: match[1],
        owner: segments.slice(0, -1).join('/'),
        repo: segments[segments.length - 1],
    };
}
/** Encode an owner path and repo for an API path, preserving owner slashes. */
export function encodeRepoPath(owner, repo) {
    return `${owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(repo)}`;
}
// ── gitLocal service ─────────────────────────────────────────────────────────
export class GitLocalService extends Service {
    constructor(ctx) {
        super(ctx, 'gitLocal');
    }
}
// ── gitPlatform service ──────────────────────────────────────────────────────
export class GitPlatformService extends Service {
    constructor(ctx) {
        super(ctx, 'gitPlatform');
    }
}
//# sourceMappingURL=index.js.map