//! Git + GitHub integration, via the `git` and `gh` CLIs.
//!
//! Everything here is a thin, blocking wrapper around one-shot CLI
//! invocations — no shells, no string interpolation into commands. Paths
//! must be absolute; branch/repo names are validated against a strict
//! charset. `gh` owns auth (its token stays in the OS keychain); the app
//! never stores credentials.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// On Windows, one-shot child processes must not flash a console window.
#[cfg(windows)]
fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_console_window(_cmd: &mut Command) {}

/// Run a program with piped stdout/stderr, optional cwd and optional stdin
/// bytes. Returns trimmed stdout on success, or the first stderr line.
fn run(
    prog: &str,
    args: &[&str],
    cwd: Option<&Path>,
    stdin_data: Option<&[u8]>,
) -> Result<String, String> {
    let mut cmd = Command::new(prog);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not run '{prog}': {e}"))?;
    if let Some(data) = stdin_data {
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "git: no stdin pipe".to_string())?
            .write_all(data)
            .map_err(|e| format!("git: stdin write failed: {e}"))?;
        // stdin is closed when `child` is consumed by wait_with_output below.
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("'{prog}' failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().next().unwrap_or("").trim();
        return Err(if first.is_empty() {
            format!("'{prog}' exited with status {}", out.status)
        } else {
            first.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn abs_dir<'a>(path: &'a str, what: &str) -> Result<&'a Path, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err(format!("{what}: empty path"));
    }
    let p = Path::new(p);
    if !p.is_absolute() {
        return Err(format!("{what}: path must be absolute"));
    }
    if !p.is_dir() {
        return Err(format!("{what}: not a folder: {}", p.display()));
    }
    Ok(p)
}

/// Strict charset for branch and repo names: no shell metachars, no `..`.
fn valid_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n.len() <= 100
        && !n.starts_with('-')
        && !n.contains("..")
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

fn valid_repo_ref(full: &str) -> bool {
    let mut parts = full.trim().split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(o), Some(r), None)
        if valid_name(o) && valid_name(r))
}

/// Is the `gh` CLI on PATH?
#[tauri::command]
pub fn gh_available() -> bool {
    run("gh", &["--version"], None, None).is_ok()
}

#[derive(Serialize)]
pub struct GhAuth {
    pub logged_in: bool,
    pub user: Option<String>,
}

/// `gh` auth state. Never touches the token — `gh` keeps it in the keychain.
#[tauri::command]
pub fn gh_auth_status() -> GhAuth {
    let logged_in = run("gh", &["auth", "status", "-h", "github.com"], None, None).is_ok();
    let user = if logged_in {
        run("gh", &["api", "user", "--jq", ".login"], None, None).ok()
    } else {
        None
    };
    GhAuth { logged_in, user }
}

/// Log in with a personal access token (classic, `repo` scope). The token is
/// piped to `gh` over stdin and never stored by the app — `gh` puts it in
/// the OS keychain. Returns the GitHub username.
#[tauri::command]
pub fn gh_auth_login_token(token: String) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("paste a token first".to_string());
    }
    run(
        "gh",
        &["auth", "login", "--with-token", "-h", "github.com"],
        None,
        Some(token.as_bytes()),
    )?;
    run("gh", &["api", "user", "--jq", ".login"], None, None)
        .map_err(|_| "logged in, but could not read the username".to_string())
}

#[derive(Serialize)]
pub struct GitInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub dirty: bool,
    pub changed: u32,
    pub remote: Option<String>,
    pub owner_repo: Option<String>,
}

fn parse_owner_repo(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    // https://github.com/owner/repo  |  git@github.com:owner/repo
    // ssh://git@github.com/owner/repo
    let path = if let Some(rest) = r.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = r.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = r.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = r.strip_prefix("ssh://git@github.com/") {
        rest
    } else {
        return None;
    };
    let mut parts = path.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(o), Some(r), None) if valid_name(o) && valid_name(r) => {
            Some(format!("{o}/{r}"))
        }
        _ => None,
    }
}

/// Branch, dirty state, and remote for a project space folder.
#[tauri::command]
pub fn git_info(path: String) -> Result<GitInfo, String> {
    let dir = abs_dir(&path, "git_info")?;
    let is_repo = run("git", &["rev-parse", "--git-dir"], Some(dir), None).is_ok();
    if !is_repo {
        return Ok(GitInfo {
            is_repo: false,
            branch: None,
            dirty: false,
            changed: 0,
            remote: None,
            owner_repo: None,
        });
    }
    let branch = run("git", &["branch", "--show-current"], Some(dir), None)
        .ok()
        .filter(|b| !b.is_empty());
    let changed = run("git", &["status", "--porcelain"], Some(dir), None)
        .map(|s| {
            if s.is_empty() {
                0
            } else {
                s.lines().count() as u32
            }
        })
        .unwrap_or(0);
    let remote = run("git", &["remote", "get-url", "origin"], Some(dir), None).ok();
    let owner_repo = remote.as_deref().and_then(parse_owner_repo);
    Ok(GitInfo {
        is_repo: true,
        branch,
        dirty: changed > 0,
        changed,
        remote,
        owner_repo,
    })
}

#[derive(Deserialize)]
struct GhRepoJson {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
    #[serde(rename = "isPrivate")]
    is_private: bool,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Serialize)]
pub struct Repo {
    pub full_name: String,
    pub private: bool,
    pub updated: String,
}

/// The user's repos, newest first.
#[tauri::command]
pub fn gh_repo_list() -> Result<Vec<Repo>, String> {
    let json = run(
        "gh",
        &[
            "repo",
            "list",
            "--json",
            "nameWithOwner,isPrivate,updatedAt",
            "--limit",
            "50",
        ],
        None,
        None,
    )?;
    let repos: Vec<GhRepoJson> =
        serde_json::from_str(&json).map_err(|e| format!("could not parse gh output: {e}"))?;
    Ok(repos
        .into_iter()
        .map(|r| Repo {
            full_name: r.name_with_owner,
            private: r.is_private,
            updated: r.updated_at,
        })
        .collect())
}

/// Clone `owner/repo` into `parent/`. Returns the new folder path.
#[tauri::command]
pub fn gh_clone(full_name: String, parent: String) -> Result<String, String> {
    if !valid_repo_ref(&full_name) {
        return Err("clone: expected owner/repo".to_string());
    }
    let parent = abs_dir(&parent, "clone")?;
    let repo = full_name.trim().rsplit('/').next().unwrap_or("");
    let dest = parent.join(repo);
    if dest.exists() {
        return Err(format!("already exists: {}", dest.display()));
    }
    run(
        "gh",
        &["repo", "clone", full_name.trim(), &dest.to_string_lossy()],
        Some(parent),
        None,
    )?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Turn a project space into a new GitHub repo and push. Initializes git and
/// makes an initial commit if the folder needs it. Returns the repo URL.
#[tauri::command]
pub fn gh_repo_create(path: String, name: String, is_private: bool) -> Result<String, String> {
    let dir = abs_dir(&path, "repo_create")?;
    let name = name.trim();
    if !valid_name(name) || name.contains('/') {
        return Err("repo name: letters, numbers, - _ . only".to_string());
    }
    if run("git", &["rev-parse", "--git-dir"], Some(dir), None).is_err() {
        run("git", &["init", "-b", "main"], Some(dir), None)?;
    }
    // `gh repo create --source --push` needs at least one commit.
    if run("git", &["rev-parse", "HEAD"], Some(dir), None).is_err() {
        run("git", &["add", "-A"], Some(dir), None)?;
        run("git", &["commit", "-m", "Initial commit"], Some(dir), None)?;
    }
    let visibility = if is_private { "--private" } else { "--public" };
    run(
        "gh",
        &[
            "repo",
            "create",
            name,
            visibility,
            "--source",
            &dir.to_string_lossy(),
            "--push",
        ],
        None,
        None,
    )?;
    run("git", &["remote", "get-url", "origin"], Some(dir), None)
}

/// Stage everything and commit. Returns the short hash.
#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    let dir = abs_dir(&path, "commit")?;
    let message = message.trim();
    if message.is_empty() {
        return Err("commit: write a message first".to_string());
    }
    if message.len() > 500 {
        return Err("commit: message too long (500 max)".to_string());
    }
    run("git", &["add", "-A"], Some(dir), None)?;
    run("git", &["commit", "-m", message], Some(dir), None)?;
    run("git", &["rev-parse", "--short", "HEAD"], Some(dir), None)
}

#[tauri::command]
pub fn git_branches(path: String) -> Result<Vec<String>, String> {
    let dir = abs_dir(&path, "branches")?;
    let out = run("git", &["branch", "--format=%(refname:short)"], Some(dir), None)?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[tauri::command]
pub fn git_branch_create(path: String, name: String) -> Result<String, String> {
    let dir = abs_dir(&path, "branch_create")?;
    let name = name.trim();
    if !valid_name(name) {
        return Err("branch name: letters, numbers, - _ . / only".to_string());
    }
    run("git", &["checkout", "-b", name], Some(dir), None)?;
    Ok(name.to_string())
}

#[tauri::command]
pub fn git_branch_switch(path: String, name: String) -> Result<String, String> {
    let dir = abs_dir(&path, "branch_switch")?;
    let name = name.trim();
    if !valid_name(name) {
        return Err("branch: bad name".to_string());
    }
    run("git", &["checkout", name], Some(dir), None)?;
    Ok(name.to_string())
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    let dir = abs_dir(&path, "push")?;
    let out = run("git", &["push", "-u", "origin", "HEAD"], Some(dir), None)?;
    Ok(if out.is_empty() { "pushed".to_string() } else { out })
}

#[tauri::command]
pub fn git_pull(path: String) -> Result<String, String> {
    let dir = abs_dir(&path, "pull")?;
    let out = run("git", &["pull", "--ff-only"], Some(dir), None)?;
    Ok(if out.is_empty() { "already up to date".to_string() } else { out })
}

/// Fork `owner/repo` and clone the fork into `parent/`. Returns the new path.
#[tauri::command]
pub fn gh_fork(full_name: String, parent: String) -> Result<String, String> {
    if !valid_repo_ref(&full_name) {
        return Err("fork: expected owner/repo".to_string());
    }
    let parent = abs_dir(&parent, "fork")?;
    run("gh", &["repo", "fork", full_name.trim(), "--clone"], Some(parent), None)?;
    let repo = full_name.trim().rsplit('/').next().unwrap_or("");
    Ok(parent.join(repo).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation() {
        assert!(valid_name("feature/login"));
        assert!(valid_name("v1.2_hot-fix"));
        assert!(!valid_name(""));
        assert!(!valid_name("a; rm -rf /"));
        assert!(!valid_name("a b"));
        assert!(!valid_name("../escape"));
        assert!(!valid_name("-dash"));
    }

    #[test]
    fn repo_ref_validation() {
        assert!(valid_repo_ref("octocat/hello-world"));
        assert!(!valid_repo_ref("just-a-name"));
        assert!(!valid_repo_ref("a/b/c"));
        assert!(!valid_repo_ref("a/b; evil"));
    }

    #[test]
    fn owner_repo_parsing() {
        assert_eq!(
            parse_owner_repo("https://github.com/octocat/hello.git"),
            Some("octocat/hello".to_string())
        );
        assert_eq!(
            parse_owner_repo("git@github.com:octocat/hello.git"),
            Some("octocat/hello".to_string())
        );
        assert_eq!(parse_owner_repo("https://gitlab.com/o/r.git"), None);
    }
}
