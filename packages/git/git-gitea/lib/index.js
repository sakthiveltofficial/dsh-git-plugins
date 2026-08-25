import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { gitFetchJson, GitError, } from '@dsh-git/core';
export const name = 'git-gitea';
export const inject = ['gitPlatform', 'credentials'];
async function authHeaders(ctx, config) {
    const ref = config.tokenRef;
    if (!ref)
        return {};
    const resolved = await ctx.credentials.resolve(credentialRef(ref));
    if (!resolved)
        return {};
    return { Authorization: `token ${resolved.value}` };
}
export function apply(ctx, config) {
    const base = config.baseUrl.replace(/\/$/, '');
    const host = (() => {
        try {
            return new URL(base).host;
        }
        catch {
            return '';
        }
    })();
    const hostPattern = host ? new RegExp(`^(?:[a-z][a-z0-9+.-]*:\\/\\/)?(?:[^@/]+@)?${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/:]|$)`, 'i') : null;
    async function ga(method, path, body, signal) {
        const headers = await authHeaders(ctx, config);
        return gitFetchJson(`${base}/api/v1${path}`, { method, headers, body, signal });
    }
    function repoPath(owner, repo) {
        return `${owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(repo)}`;
    }
    function mapPr(x) {
        return { number: x.number, url: x.html_url ?? x.url ?? '', title: x.title ?? '', state: x.state ?? '' };
    }
    function mapPrSummary(x) {
        return {
            number: x.number, title: x.title ?? '', state: x.state ?? '', url: x.html_url ?? x.url ?? '',
            head: x.head?.ref ?? '', base: x.base?.ref ?? '', author: x.user?.login ?? '', createdAt: x.created_at ?? '',
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
    function mapRun(x) {
        return { id: String(x.id), name: x.name ?? x.display_title ?? String(x.id), status: x.status ?? '', conclusion: x.conclusion, url: x.html_url ?? x.url ?? '', branch: x.head_branch, createdAt: x.created_at };
    }
    function mapJob(x) {
        return { id: String(x.id), name: x.name ?? '', status: x.status ?? '', conclusion: x.conclusion };
    }
    const provider = {
        platform: 'gitea',
        matchesRemote(url) {
            if (!hostPattern)
                return false;
            return hostPattern.test(url);
        },
        async createPullRequest(req) {
            const data = await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/pulls`, {
                title: req.title, head: req.head, base: req.base, body: req.body,
            }, req.signal);
            return mapPr(data);
        },
        async listPullRequests(req) {
            const query = new URLSearchParams({ state: req.state ?? 'open', limit: String(req.limit ?? 30) }).toString();
            const data = await ga('GET', `/repos/${repoPath(req.owner, req.repo)}/pulls?${query}`, undefined, req.signal);
            return data.map(mapPrSummary);
        },
        async mergePullRequest(req) {
            const doMethod = req.method === 'squash' ? 'squash' : req.method === 'rebase' ? 'rebase' : 'merge';
            try {
                await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/pulls/${req.number}/merge`, { Do: doMethod }, req.signal);
            }
            catch (error) {
                if (error instanceof GitError && (error.status === 404 || error.status === 405 || error.status === 409)) {
                    throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error });
                }
                throw error;
            }
        },
        async addReviewComment(req) {
            await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/pulls/${req.pullNumber}/comments`, { body: req.body }, req.signal);
        },
        async listIssues(req) {
            const query = new URLSearchParams({ state: req.state ?? 'open', limit: String(req.limit ?? 30) }).toString();
            const data = await ga('GET', `/repos/${repoPath(req.owner, req.repo)}/issues?${query}`, undefined, req.signal);
            return data.filter((x) => !x.pull_request).map(mapIssue);
        },
        async createIssue(req) {
            // Gitea labels are numeric ids on create; passing names is unreliable, so labels are omitted.
            const data = await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/issues`, {
                title: req.title, body: req.body,
            }, req.signal);
            return mapIssue(data);
        },
        async createRelease(req) {
            const data = await ga('POST', `/repos/${repoPath(req.owner, req.repo)}/releases`, {
                tag_name: req.tag, name: req.name, body: req.body, draft: req.draft ?? false, prerelease: req.prerelease ?? false,
            }, req.signal);
            return mapRelease(data);
        },
        async listSecurityAlerts(_req) {
            throw new GitError('Gitea does not expose Dependabot-style security alerts; not supported by this adapter', 'GIT_UNSUPPORTED');
        },
        async listPipelines(req) {
            // Gitea Actions API (Gitea >= 1.21 with Actions enabled) mirrors GitHub's shapes.
            const query = new URLSearchParams({ limit: String(req.limit ?? 30) });
            if (req.branch)
                query.set('branch', req.branch);
            const data = await ga('GET', `/repos/${repoPath(req.owner, req.repo)}/actions/runs?${query.toString()}`, undefined, req.signal);
            return (data?.workflow_runs ?? (Array.isArray(data) ? data : [])).map(mapRun);
        },
        async getPipelineRun(req) {
            const base = `/repos/${repoPath(req.owner, req.repo)}/actions/runs/${encodeURIComponent(req.id)}`;
            const run = await ga('GET', base, undefined, req.signal);
            let jobs = [];
            try {
                const jobData = await ga('GET', `${base}/jobs`, undefined, req.signal);
                jobs = (jobData?.jobs ?? (Array.isArray(jobData) ? jobData : [])).map(mapJob);
            }
            catch {
                // jobs are best-effort
            }
            return { id: String(run.id), name: run.name ?? run.display_title ?? String(run.id), status: run.status ?? '', conclusion: run.conclusion, url: run.html_url ?? run.url ?? '', jobs };
        },
    };
    return ctx.gitPlatform.registerProvider(provider);
}
// Attach inject directly on the function — Cordis reads plugin.inject (the
// function's own property) not the module-level `export const inject`.
apply.inject = inject;
export default apply;
//# sourceMappingURL=index.js.map