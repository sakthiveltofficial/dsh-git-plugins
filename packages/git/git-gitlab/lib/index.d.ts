/**
 * @dsh-git/gitlab — GitLab adapter for `gitPlatform`.
 *
 * REST v4 (`{baseUrl}/api/v4`). GitLab identifies projects by URL-encoded path
 * (`group/subgroup/repo` → `group%2Fsubgroup%2Frepo`), so owner segments are
 * encoded as one path, not per segment. Auth is the `PRIVATE-TOKEN` header,
 * resolved per operation through `ctx.credentials`.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface Config {
    /** Env-var REFERENCE for the private token (e.g. `GITLAB_TOKEN`). */
    tokenRef?: string;
    /** Host base URL, e.g. `https://gitlab.com` or a self-hosted instance. */
    baseUrl?: string;
}
export declare const name = "git-gitlab";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): () => void;
export declare namespace apply {
    var inject: string[];
}
export default apply;
//# sourceMappingURL=index.d.ts.map