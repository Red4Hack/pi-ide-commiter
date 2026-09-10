/**
 * Minimal subset of the `vscode.git` extension API that we use.
 * The git extension does not publish types on npm, so we declare only what we need.
 */

import type { Uri } from "vscode";

export interface GitInputBox {
	value: string;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: GitInputBox;
}

export interface GitAPI {
	readonly repositories: Repository[];
	getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): GitAPI;
}
