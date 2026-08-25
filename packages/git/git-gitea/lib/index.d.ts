/**
 * @dsh-git/gitea — Gitea adapter for `gitPlatform`.
 *
 * Gitea's REST API (v1) is GitHub-shaped, so this adapter closely mirrors the
 * GitHub one. `baseUrl` is REQUIRED (any self-hosted Gitea instance), and auth
 * is `Authorization: token <token>`. Gitea has no Dependabot-style alerts API;
 * `listSecurityAlerts` fails loudly with GIT_UNSUPPORTED.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface Config {
    /** Env-var REFERENCE for the access token (e.g. `GITEA_TOKEN`). */
    tokenRef?: string;
    /** REQUIRED: the Gitea instance base URL, e.g. `https://gitea.example.com`. */
    baseUrl: string;
}
export declare const name = "git-gitea";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): () => void;
export declare namespace apply {
    var inject: string[];
}
export default apply;
//# sourceMappingURL=index.d.ts.map