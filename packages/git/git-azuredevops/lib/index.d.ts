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
import type { Context } from '@deepseek-ai/cordis';
export interface Config {
    /** Env-var REFERENCE for the Personal Access Token (e.g. `AZURE_DEVOPS_PAT`). */
    patRef?: string;
    /** Organization base URL (default `https://dev.azure.com`). */
    baseUrl?: string;
    /** REST API version (default `7.1`). */
    apiVersion?: string;
}
export declare const name = "git-azuredevops";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): () => void;
export declare namespace apply {
    var inject: string[];
}
export default apply;
//# sourceMappingURL=index.d.ts.map