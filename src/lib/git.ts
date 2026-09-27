import { invoke } from "@tauri-apps/api/core";

export interface GhAuth {
  logged_in: boolean;
  user: string | null;
}

export interface GitInfo {
  is_repo: boolean;
  branch: string | null;
  dirty: boolean;
  changed: number;
  remote: string | null;
  owner_repo: string | null;
}

export interface Repo {
  full_name: string;
  private: boolean;
  updated: string;
}

export async function ghAvailable(): Promise<boolean> {
  return invoke<boolean>("gh_available");
}

export async function ghAuthStatus(): Promise<GhAuth> {
  return invoke<GhAuth>("gh_auth_status");
}

/** Log in with a PAT. The token goes to `gh` over stdin; the app never stores it. */
export async function ghAuthLoginToken(token: string): Promise<string> {
  return invoke<string>("gh_auth_login_token", { token });
}

export async function gitInfo(path: string): Promise<GitInfo> {
  return invoke<GitInfo>("git_info", { path });
}

export async function ghRepoList(): Promise<Repo[]> {
  return invoke<Repo[]>("gh_repo_list");
}

export async function ghClone(fullName: string, parent: string): Promise<string> {
  return invoke<string>("gh_clone", { full_name: fullName, parent });
}

export async function ghRepoCreate(
  path: string,
  name: string,
  isPrivate: boolean
): Promise<string> {
  return invoke<string>("gh_repo_create", { path, name, is_private: isPrivate });
}

export async function gitCommit(path: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { path, message });
}

export async function gitBranches(path: string): Promise<string[]> {
  return invoke<string[]>("git_branches", { path });
}

export async function gitBranchCreate(path: string, name: string): Promise<string> {
  return invoke<string>("git_branch_create", { path, name });
}

export async function gitBranchSwitch(path: string, name: string): Promise<string> {
  return invoke<string>("git_branch_switch", { path, name });
}

export async function gitPush(path: string): Promise<string> {
  return invoke<string>("git_push", { path });
}

export async function gitPull(path: string): Promise<string> {
  return invoke<string>("git_pull", { path });
}

export async function ghFork(fullName: string, parent: string): Promise<string> {
  return invoke<string>("gh_fork", { full_name: fullName, parent });
}
