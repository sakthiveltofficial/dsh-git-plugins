import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { gitFetchJson, GitError, } from '@dsh-git/core';
export const name = 'git-azuredevops';
export const inject = ['gitPlatform', 'credentials'];
const AZURE_HOSTS = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?(?:dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)([/:]|$)/i;
async function authHeaders(ctx, config) {
    const ref = config.patRef;
    if (!ref)
        return {};
    const resolved = await ctx.credentials.resolve(credentialRef(ref));
    if (!resolved)
        return {};
    const token = Buffer.from(`:${resolved.value}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}
/** `org/project` → `org/project` with each segment encoded separately. */
function orgProjectPath(owner) {
    return owner.split('/').map(encodeURIComponent).join('/');
}
export function apply(ctx, config = {}) {
    const base = (config.baseUrl ?? 'https://dev.azure.com').replace(/\/$/, '');
    const apiVersion = config.apiVersion ?? '7.1';
    async function az(method, path, body, signal, headers) {
        const auth = await authHeaders(ctx, config);
        return gitFetchJson(`${base}${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`, {
            method, headers: { ...auth, ...headers }, body, signal,
        });
    }
    function repoPath(owner, repo) {
        return `${orgProjectPath(owner)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
    }
    function prState(x) {
        if (x === 'active')
            return 'open';
        if (x === 'completed' || x === 'abandoned')
            return 'closed';
        return x;
    }
    function mapPr(x) {
        return { number: x.pullRequestId, url: x.url ?? '', title: x.title ?? '', state: prState(x.status ?? '') };
    }
    function mapPrSummary(x) {
        return {
            number: x.pullRequestId, title: x.title ?? '', state: prState(x.status ?? ''), url: x.url ?? '',
            head: (x.sourceRefName ?? '').replace(/^refs\/heads\//, ''), base: (x.targetRefName ?? '').replace(/^refs\/heads\//, ''),
            author: x.createdBy?.displayName ?? '', createdAt: x.creationDate ?? '',
        };
    }
    function mapRun(x) {
        return {
            id: String(x.id), name: x.buildNumber ?? String(x.id), status: x.status ?? '',
            conclusion: x.result ?? undefined, url: x._links?.web?.href ?? x.url ?? '', branch: (x.sourceBranch ?? '').replace(/^refs\/heads\//, ''),
        };
    }
    function mapJob(x) {
        return { id: String(x.id ?? x.recordId), name: x.name ?? '', status: (x.status ?? '').toLowerCase(), conclusion: (x.result ?? '').toLowerCase() };
    }
    const provider = {
        platform: 'azuredevops',
        matchesRemote(url) {
            return AZURE_HOSTS.test(url);
        },
        async createPullRequest(req) {
            const data = await az('POST', `/${repoPath(req.owner, req.repo)}/pullrequests`, {
                title: req.title, description: req.body,
                sourceRefName: `refs/heads/${req.head}`, targetRefName: `refs/heads/${req.base}`,
            }, req.signal);
            return mapPr(data);
        },
        async listPullRequests(req) {
            const status = req.state === 'all' ? 'all' : req.state ?? 'active';
            const data = await az('GET', `/${repoPath(req.owner, req.repo)}/pullrequests?searchCriteria.status=${status}&$top=${req.limit ?? 30}`, undefined, req.signal);
            return (data?.value ?? []).map(mapPrSummary);
        },
        async mergePullRequest(req) {
            const mergeStrategy = req.method === 'squash' ? 'squash' : req.method === 'rebase' ? 'rebase' : 'noFastForward';
            try {
                await az('PATCH', `/${repoPath(req.owner, req.repo)}/pullrequests/${req.number}`, {
                    status: 'completed', completionOptions: { mergeStrategy },
                }, req.signal);
            }
            catch (error) {
                if (error instanceof GitError && (error.status === 409 || error.status === 400)) {
                    throw new GitError(`pull request #${req.number} cannot be merged (conflict or checks pending)`, 'GIT_CONFLICT', { cause: error });
                }
                throw error;
            }
        },
        async addReviewComment(req) {
            await az('POST', `/${repoPath(req.owner, req.repo)}/pullrequests/${req.pullNumber}/threads`, {
                comments: [{ content: req.body }], status: 'active',
            }, req.signal);
        },
        async listIssues(req) {
            const project = req.owner.split('/').at(-1) ?? req.owner;
            const query = `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.WorkItemType] = 'Issue' ORDER BY [System.CreatedDate] DESC`;
            const wiql = await az('POST', `/${orgProjectPath(req.owner)}/_apis/wit/wiql`, { query }, req.signal);
            const ids = (wiql?.workItems ?? []).slice(0, req.limit ?? 30).map((w) => w.id);
            if (ids.length === 0)
                return [];
            const data = await az('GET', `/${orgProjectPath(req.owner)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.CreatedDate,System.CreatedBy`, undefined, req.signal);
            return (data?.value ?? []).map((x) => {
                const f = x.fields ?? {};
                return {
                    number: x.id, title: f['System.Title'] ?? '', state: (f['System.State'] ?? '').toLowerCase(), url: `${base}/${req.owner}/_workitems/edit/${x.id}`,
                    author: f['System.CreatedBy']?.displayName ?? '', createdAt: f['System.CreatedDate'] ?? '', body: undefined, labels: [],
                };
            });
        },
        async createIssue(req) {
            const ops = [
                { op: 'add', path: '/fields/System.Title', value: req.title },
                ...(req.body ? [{ op: 'add', path: '/fields/System.Description', value: req.body }] : []),
            ];
            const data = await az('POST', `/${orgProjectPath(req.owner)}/_apis/wit/workitems/$Issue`, ops, req.signal, { 'Content-Type': 'application/json-patch+json' });
            const f = data.fields ?? {};
            return {
                number: data.id, title: f['System.Title'] ?? req.title, state: (f['System.State'] ?? 'new').toLowerCase(), url: `${base}/${req.owner}/_workitems/edit/${data.id}`,
                author: f['System.CreatedBy']?.displayName ?? '', createdAt: f['System.CreatedDate'] ?? '', body: req.body, labels: [],
            };
        },
        async createRelease(_req) {
            throw new GitError('Azure DevOps releases require a Release pipeline; not supported by this adapter', 'GIT_UNSUPPORTED');
        },
        async listSecurityAlerts(_req) {
            throw new GitError('Azure DevOps does not expose repository security alerts; not supported by this adapter', 'GIT_UNSUPPORTED');
        },
        async listPipelines(req) {
            const data = await az('GET', `/${orgProjectPath(req.owner)}/_apis/build/builds?$top=${req.limit ?? 30}&queryOrder=queueTimeDescending`, undefined, req.signal);
            const values = data.value ?? [];
            const filtered = values.filter((x) => !req.branch || (x.sourceBranch ?? '').replace(/^refs\/heads\//, '') === req.branch);
            return filtered.map(mapRun);
        },
        async getPipelineRun(req) {
            const run = await az('GET', `/${orgProjectPath(req.owner)}/_apis/build/builds/${encodeURIComponent(req.id)}`, undefined, req.signal);
            let jobs = [];
            try {
                const timeline = await az('GET', `/${orgProjectPath(req.owner)}/_apis/build/builds/${encodeURIComponent(req.id)}/timeline`, undefined, req.signal);
                jobs = (timeline?.records ?? []).filter((r) => r.type === 'Task').map(mapJob);
            }
            catch {
                // timeline is best-effort
            }
            return {
                id: String(run.id), name: run.buildNumber ?? String(run.id), status: run.status ?? '', conclusion: run.result,
                url: run._links?.web?.href ?? run.url ?? '', jobs,
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