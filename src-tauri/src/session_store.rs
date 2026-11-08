use crate::file_io::{self, FileError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub path: Option<String>,
    #[serde(default)]
    pub anchor: usize,
    #[serde(default)]
    pub head: usize,
    #[serde(default)]
    pub scroll_top: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSession {
    pub key: String,
    pub tabs: Vec<SessionTab>,
    pub active_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub version: u32,
    pub restore_on_startup: bool,
    pub windows: Vec<WindowSession>,
}

impl Default for SessionManifest {
    fn default() -> Self {
        Self { version: 1, restore_on_startup: true, windows: Vec::new() }
    }
}

fn manifest_path(data_dir: &Path) -> PathBuf { data_dir.join("last-session.json") }

pub fn load(data_dir: &Path) -> Result<SessionManifest, FileError> {
    let path = manifest_path(data_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(SessionManifest::default()),
        Err(error) => return Err(FileError { kind: "io", message: format!("读取会话状态 {} 失败：{error}", path.display()) }),
    };
    serde_json::from_slice::<SessionManifest>(&bytes).map_err(|error| FileError {
        kind: "io", message: format!("会话状态 {} 无法解析：{error}", path.display()),
    })
}

pub fn save(data_dir: &Path, manifest: &SessionManifest) -> Result<(), FileError> {
    fs::create_dir_all(data_dir).map_err(|error| FileError {
        kind: "io", message: format!("创建会话目录 {} 失败：{error}", data_dir.display()),
    })?;
    let path = manifest_path(data_dir);
    let bytes = serde_json::to_vec(manifest).map_err(|error| FileError {
        kind: "io", message: format!("序列化会话状态失败：{error}"),
    })?;
    file_io::write_atomic(&path, &bytes, path.exists(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn session_round_trip_and_replace_existing() {
        let root = std::env::temp_dir().join(format!("mintdown-session-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let mut manifest = SessionManifest::default();
        manifest.windows.push(WindowSession { key: "main".into(), active_id: Some("b".into()), tabs: vec![
            SessionTab { id: "a".into(), path: Some(r"D:\中文 文件.md".into()), anchor: 42, head: 42, scroll_top: 349.5 },
            SessionTab { id: "b".into(), path: None, anchor: 3, head: 3, scroll_top: 0.0 },
        ] });
        save(&root, &manifest).unwrap();
        let restored = load(&root).unwrap();
        assert_eq!(restored.windows[0].tabs[0].scroll_top, 349.5);
        assert_eq!(restored.windows[0].active_id.as_deref(), Some("b"));
        manifest.windows[0].tabs.remove(0);
        save(&root, &manifest).unwrap();
        assert_eq!(load(&root).unwrap().windows[0].tabs.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
