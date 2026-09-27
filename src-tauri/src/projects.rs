//! Project space helpers: creating and renaming workspace folders on disk.

use std::path::Path;

/// Create a directory (and any missing parents) for a new project space.
#[tauri::command]
pub fn project_create_dir(path: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("project_create_dir: empty path".to_string());
    }
    // Refuse anything that doesn't look like an absolute path, to avoid
    // accidentally creating folders relative to the app's install dir.
    let abs = Path::new(p);
    if !abs.is_absolute() {
        return Err("project_create_dir: path must be absolute".to_string());
    }
    if abs.exists() {
        return Err(format!("Folder already exists: {}", abs.display()));
    }
    std::fs::create_dir_all(abs)
        .map_err(|e| format!("could not create {}: {e}", abs.display()))?;
    Ok(abs.to_string_lossy().into_owned())
}

/// Rename a project space folder on disk. Returns the new absolute path.
#[tauri::command]
pub fn project_rename_dir(old_path: String, new_path: String) -> Result<String, String> {
    let old = Path::new(old_path.trim());
    let new = Path::new(new_path.trim());
    if !old.is_absolute() || !new.is_absolute() {
        return Err("project_rename_dir: both paths must be absolute".to_string());
    }
    if !old.exists() {
        return Err(format!("Folder not found: {}", old.display()));
    }
    if new.exists() {
        return Err(format!("A folder already exists at: {}", new.display()));
    }
    // Keep the rename inside the same parent directory — no moves across disks.
    if old.parent() != new.parent() {
        return Err("project_rename_dir: cannot move a space to a different folder".to_string());
    }
    std::fs::rename(old, new)
        .map_err(|e| format!("could not rename {}: {e}", old.display()))?;
    Ok(new.to_string_lossy().into_owned())
}
