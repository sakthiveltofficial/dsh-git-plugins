import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { gitFetchJson, GitError, } from '@dsh-git/core';
export const name = 'git-bitbucket';
export const inject = ['gitPlatform', 'credentials'];
async function authHeaders(ctx, config) {
    if (!config.username || !config.appPasswordRef)
        return {};
    const resolved = await ctx.credentials.resolve(credentialRef(config.appPasswordRef));
    if (!resolved)
        return {};
    const token = Buffer.from(`${config.username}:${resolved.value}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}
function hostOf(config) {
    try {
        return new URL(config.baseUrl ?? 'https://api.bitbucket.org/2.0').host;
    }
    catch {
        return 'bitbucket.org';
    }
}
export function apply(ctx, config = {}) {
    const base = (config.baseUrl ?? 'https://api.bitbucket.org/2.0').replace(/\/$/, '');
    const host = hostOf(config);
    // Match the Cloud SCM host (`bitbucket.org`) and any configured API host (self-hosted).
    const hostPattern = new RegExp(`^(?:[a-z][a-z0-9+.-]*:\\/\\/)?(?:[^@/]+@)?(?:bitbucket\\.org|${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([/:]|$)`, 'i');
    async function bb(method, path, body, signal) {
        const headers = await authHeaders(ctx, config);
        return gitFetchJson(`${base}${path}`, { method, headers, body, signal });
    }
    function repoPath(owner, repo) {
        return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    }
    // ── normalization ──────────────────────────────────────────────────────────
    function mapPr(x) {
        return { number: x.id, url: x.links?.html?.href ?? '', title: x.title ?? '', state: (x.state ?? '').toLowerCase() };
    }
    function mapPrSummary(x) {
        return {
            number: x.id, title: x.title ?? '', state: (x.state ?? '').toLowerCase(), url: x.links?.html?.href ?? '',
            head: x.source?.branch?.name ?? '', base: x.destination?.branch?.name ?? '', author: x.author?.display_name ?? x.author?.nickname ?? '',
            createdAt: x.created_on ?? '',
        };
    }
    function mapIssue(x) {
        return {
            number: x.id, title: x.title ?? '', state: (x.state ?? '').toLowerCase(), url: x.links?.html?.href ?? '',
            author: x.reporter?.display_name ?? x.reporter?.nickname ?? '', createdAt: x.created_on ?? '',
            body: x.content?.raw ?? undefined, labels: (x.labels ?? []).map((l) => l.name ?? l),
        };
    }
    function mapJob(x) {
        return { id: String(x.uuid ?? x.key ?? x.id), name: x.name ?? '', status: (x.state?.name ?? '').toLowerCase(), conclusion: x.state?.result?.name?.toLowerCase() };
    }
    function mapRun(x) {
        return {
            id: String(x.uuid ?? x.id), name: x.target?.ref_name ?? String(x.uuid ?? '').slice(0, 8), status: (x.state?.name ?? '').toLowerCase(),
            conclusion: x.state?.result?.name?.toLowerCase(), url: x.links?.html?.href ?? '', branch: x.target?.ref_name,
        };
    }
    const provider = {
        platform: 'bitbucket',
        matchesRemote(url) {
            return hostPattern.test(url);
        },
        async createPullRequest(req) {
            const data = await bb('POST', `/repositories/${repoPath(req.owner, req.repo)}/pullrequests`, {
                title: req.title, description: req.body,
                source: { branch: { name: req.head } },
                destination: { branch: { name: req.base } },
            }, req.signal);
            return mapPr(data);
        },
        async listPullRequests(req) {
            const data = await bb('GET', `/repositories/${repoPath(req.owner, req.repo)}/pullrequests?state=ALL&pagelen=${req.limit ?? 30}`, undefined, req.signal);
            const values = data?.values ?? [];
            const filtered = values.filter((x) => {
                const state = (x.state ?? '').toUpperCase();
                if (req.state === 'open')
                    return state === 'OPEN';
                if (req.state === 'closed')
                    return state !== 'OPEN';
                return true;
            });
            return filtered.map(mapPrSummary);
        },
        async mergePullRequest(req) {
            const strategy = req.method === 'squash' ? 'squash' : req.method === 'rebase' ? 'fast_forward' : 'merge_commit';
            try {
                await bb('POST', `/repositories/${repoPath(req.owner, req.repo)}/pullrequests/${req.number}/merge`, { merge_strategy: strategy }, req.signal);
            }
            catch (error) {
                if (error instanceof GitError && (error.status === 409 || error.status === 422)) {
                    throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error });
                }
                throw error;
            }
        },
        async addReviewComment(req) {
            await bb('POST', `/repositories/${repoPath(req.owner, req.repo)}/pullrequests/${req.pullNumber}/comments`, { content: { raw: req.body } }, req.signal);
        },
        async listIssues(req) {
            const data = await bb('GET', `/repositories/${repoPath(req.owner, req.repo)}/issues?pagelen=${req.limit ?? 30}`, undefined, req.signal);
            const values = data?.values ?? [];
            const open = new Set(['new', 'open', 'on hold']);
            const filtered = values.filter((x) => {
                const state = (x.state ?? '').toLowerCase();
                if (req.state === 'open')
                    return open.has(state);
                if (req.state === 'closed')
                    return !open.has(state);
                return true;
            });
            return filtered.map(mapIssue);
        },
        async createIssue(req) {
            const data = await bb('POST', `/repositories/${repoPath(req.owner, req.repo)}/issues`, {
                title: req.title, content: { raw: req.body ?? '' }, labels: (req.labels ?? []).map((name) => ({ name })),
            }, req.signal);
            return mapIssue(data);
        },
        async createRelease(req) {
            // Bitbucket Cloud has no releases API; create the tag the release would point at.
            const data = await bb('POST', `/repositories/${repoPath(req.owner, req.repo)}/refs/tags`, {
                name: req.tag, target: req.ref ? { hash: req.ref } : undefined,
            }, req.signal);
            return { id: String(data.name ?? req.tag), tag: data.name ?? req.tag, name: data.name ?? req.tag, url: data.links?.html?.href ?? `${base}/${req.owner}/${req.repo}/refs/tags`, draft: false, prerelease: false };
        },
        async listSecurityAlerts(_req) {
            throw new GitError('Bitbucket Cloud does not expose repository security alerts; not supported by this adapter', 'GIT_UNSUPPORTED');
        },
        async listPipelines(req) {
            const data = await bb('GET', `/repositories/${repoPath(req.owner, req.repo)}/pipelines/?pagelen=${req.limit ?? 30}`, undefined, req.signal);
            const values = data?.values ?? [];
            const filtered = req.branch ? values.filter((x) => (x.target?.ref_name ?? '') === req.branch) : values;
            return filtered.map(mapRun);
        },
        async getPipelineRun(req) {
            const basePath = `/repositories/${repoPath(req.owner, req.repo)}/pipelines/${encodeURIComponent(req.id)}`;
            const run = await bb('GET', basePath, undefined, req.signal);
            let jobs = [];
            try {
                const stepData = await bb('GET', `${basePath}/steps/`, undefined, req.signal);
                jobs = (stepData?.values ?? []).map(mapJob);
            }
            catch {
                // steps are best-effort
            }
            return {
                id: String(run.uuid ?? run.id), name: run.target?.ref_name ?? String(run.uuid ?? '').slice(0, 8),
                status: (run.state?.name ?? '').toLowerCase(), conclusion: run.state?.result?.name?.toLowerCase(),
                url: run.links?.html?.href ?? '', jobs,
            };
        },
    };
    return ctx.gitPlatform.registerProvider(provider);
}
// Attach inject directly on the function — Cordis reads plugin.inject (the
// function's own property) not the module-level `export const inject`.
apply.inject = inject;
export default apply;
//# sourceMappingURL=index.js.map