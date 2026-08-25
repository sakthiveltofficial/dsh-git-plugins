import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { gitFetchJson, GitError, } from '@dsh-git/core';
const GITHUB_REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com([/:]|$)/i;
export const name = 'git-github';
export const inject = ['gitPlatform', 'credentials'];
function enc(value) {
    return encodeURIComponent(value);
}
async function authHeaders(ctx, config) {
    const ref = config.tokenRef;
    if (!ref)
        return {};
    const resolved = await ctx.credentials.resolve(credentialRef(ref));
    if (!resolved)
        return {};
    return { Authorization: `Bearer ${resolved.value}` };
}
async function gh(ctx, config, method, path, body, signal) {
    const headers = await authHeaders(ctx, config);
    return gitFetchJson(`${config.baseUrl ?? 'https://api.github.com'}${path}`, { method, headers, body, signal });
}
// ── normalization ────────────────────────────────────────────────────────────
function mapPr(x) {
    return { number: x.number, url: x.html_url ?? x.url ?? '', title: x.title ?? '', state: x.state ?? '' };
}
function mapPrSummary(x) {
    return {
        number: x.number, title: x.title ?? '', state: x.state ?? '', url: x.html_url ?? x.url ?? '',
        head: x.head?.ref ?? '', base: x.base?.ref ?? '', author: x.user?.login ?? '',
        createdAt: x.created_at ?? '', mergeable: x.mergeable,
    };
}
function mapIssue(x) {
    return {
        number: x.number, title: x.title ?? '', state: x.state ?? '', url: x.html_url ?? x.url ?? '',
        author: x.user?.login ?? '', createdAt: x.created_at ?? '', body: x.body ?? undefined,
        labels: (x.labels ?? []).map((l) => l.name ?? l),
    };
}
function mapRelease(x) {
    return { id: String(x.id), tag: x.tag_name ?? '', name: x.name ?? '', url: x.html_url ?? x.url ?? '', draft: !!x.draft, prerelease: !!x.prerelease };
}
function mapAlert(x) {
    return {
        id: String(x.number ?? x.ghsa_id ?? x.id), severity: x.security_severity_level ?? x.severity ?? 'unknown',
        package: x.dependency?.package?.name ?? '', advisory: x.security_advisory?.summary ?? '',
        state: x.state ?? '', url: x.html_url,
    };
}
function mapRun(x) {
    return { id: String(x.id), name: x.name ?? x.display_title ?? '', status: x.status ?? '', conclusion: x.conclusion, url: x.html_url ?? x.url ?? '', branch: x.head_branch, createdAt: x.created_at };
}
function mapJob(x) {
    return { id: String(x.id), name: x.name ?? '', status: x.status ?? '', conclusion: x.conclusion };
}
export function apply(ctx, config = {}) {
    const provider = {
        platform: 'github',
        matchesRemote(url) {
            return GITHUB_REMOTE.test(url);
        },
        async createPullRequest(req) {
            const data = await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls`, {
                title: req.title, head: req.head, base: req.base, body: req.body,
            }, req.signal);
            return mapPr(data);
        },
        async listPullRequests(req) {
            const query = new URLSearchParams({
                state: req.state ?? 'open',
                per_page: String(req.limit ?? 30),
            }).toString();
            const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls?${query}`, undefined, req.signal);
            return (data ?? []).map(mapPrSummary);
        },
        async mergePullRequest(req) {
            try {
                await gh(ctx, config, 'PUT', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls/${req.number}/merge`, {
                    merge_method: req.method ?? 'merge',
                }, req.signal);
            }
            catch (error) {
                if (error instanceof GitError && error.status === 409) {
                    throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error });
                }
                throw error;
            }
        },
        async addReviewComment(req) {
            await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/pulls/${req.pullNumber}/comments`, {
                body: req.body,
            }, req.signal);
        },
        async listIssues(req) {
            const query = new URLSearchParams({
                state: req.state ?? 'open',
                per_page: String(req.limit ?? 30),
            }).toString();
            const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/issues?${query}`, undefined, req.signal);
            return (data ?? [])
                .filter((x) => !x.pull_request) // GitHub's /issues endpoint also returns PRs
                .map(mapIssue);
        },
        async createIssue(req) {
            const data = await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/issues`, {
                title: req.title, body: req.body, labels: req.labels,
            }, req.signal);
            return mapIssue(data);
        },
        async createRelease(req) {
            const data = await gh(ctx, config, 'POST', `/repos/${enc(req.owner)}/${enc(req.repo)}/releases`, {
                tag_name: req.tag, name: req.name, body: req.body, draft: req.draft ?? false, prerelease: req.prerelease ?? false,
            }, req.signal);
            return mapRelease(data);
        },
        async listSecurityAlerts(req) {
            try {
                const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/dependabot/alerts?per_page=100`, undefined, req.signal);
                return (data ?? []).map(mapAlert);
            }
            catch (error) {
                // 404 = repo not enrolled / alerts unavailable; report an empty list rather than an error.
                if (error instanceof GitError && error.status === 404)
                    return [];
                throw error;
            }
        },
        async listPipelines(req) {
            const query = new URLSearchParams({ per_page: String(req.limit ?? 30) });
            if (req.branch)
                query.set('branch', req.branch);
            const data = await gh(ctx, config, 'GET', `/repos/${enc(req.owner)}/${enc(req.repo)}/actions/runs?${query.toString()}`, undefined, req.signal);
            return (data?.workflow_runs ?? []).map(mapRun);
        },
        async getPipelineRun(req) {
            const base = `/repos/${enc(req.owner)}/${enc(req.repo)}/actions/runs/${enc(req.id)}`;
            const run = await gh(ctx, config, 'GET', base, undefined, req.signal);
            let jobs = [];
            try {
                const jobData = await gh(ctx, config, 'GET', `${base}/jobs`, undefined, req.signal);
                jobs = (jobData.jobs ?? []).map(mapJob);
            }
            catch {
                // jobs are best-effort; a missing jobs list should not fail the run detail
            }
            return { id: String(run.id), name: run.name ?? run.display_title ?? '', status: run.status ?? '', conclusion: run.conclusion, url: run.html_url ?? run.url ?? '', jobs };
        },
    };
    return ctx.gitPlatform.registerProvider(provider);
}
// Attach inject as a property on the function so Cordis reads it correctly
// regardless of whether it calls apply() or new apply() (isConstructor returns
// true for plain functions that have a .prototype, so plugin.inject must be set
// directly on the function — the module-level `export const inject` alone is not
// sufficient).
apply.inject = inject;
export default apply;
//# sourceMappingURL=index.js.map