use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub path: String,
    pub bytes: Vec<u8>,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub kind: &'static str,
    pub message: String,
}

impl FileError {
    pub(crate) fn io(action: &str, path: &Path, error: io::Error) -> Self {
        let kind = match error.kind() {
            io::ErrorKind::NotFound => "not_found",
            io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io",
        };
        Self { kind, message: format!("{action} {} 失败：{error}", path.display()) }
    }
}

pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn open(path: &Path) -> Result<OpenedDocument, FileError> {
    let canonical = fs::canonicalize(path).map_err(|e| FileError::io("定位文件", path, e))?;
    let bytes = fs::read(&canonical).map_err(|e| FileError::io("读取文件", &canonical, e))?;
    Ok(OpenedDocument {
        path: canonical.to_string_lossy().into_owned(),
        fingerprint: fingerprint(&bytes),
        bytes,
    })
}

fn temp_path(path: &Path) -> PathBuf {
    let number = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let mut name = path.file_name().unwrap_or_else(|| std::ffi::OsStr::new("untitled")).to_os_string();
    name.push(format!(".{}.{}.tmp", std::process::id(), number));
    path.with_file_name(name)
}

fn replace_existing(temp: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
        // Rust fs accepts long paths, but raw Win32 replacement requires the
        // extended absolute form. Both files exist by this point.
        let target = fs::canonicalize(target)?;
        let temp = fs::canonicalize(temp)?;
        let backup = temp_path(&target).with_extension("b1-backup");
        let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let temp_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let backup_wide: Vec<u16> = backup.as_os_str().encode_wide().chain(Some(0)).collect();
        for attempt in 0..6 {
            let result = unsafe {
                ReplaceFileW(target_wide.as_ptr(), temp_wide.as_ptr(), backup_wide.as_ptr(), 0, std::ptr::null(), std::ptr::null())
            };
            if result != 0 {
                let _ = fs::remove_file(&backup);
                return Ok(());
            }
            let failure = io::Error::last_os_error();
            if !target.exists() && backup.exists() {
                if let Err(restore_error) = fs::rename(&backup, &target) {
                    return Err(io::Error::other(format!("替换失败：{failure}；原文件保留于 {}，恢复原路径失败：{restore_error}", backup.display())));
                }
            }
            if attempt < 5 && matches!(failure.raw_os_error(), Some(32 | 33)) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
            return Err(failure);
        }
        unreachable!()
    }
    #[cfg(not(windows))]
    { fs::rename(temp, target) }
}

pub fn write_atomic(path: &Path, bytes: &[u8], existing: bool, expected: Option<&str>) -> Result<(), FileError> {
    let temp = temp_path(path);
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)
            .map_err(|e| FileError::io("创建临时文件", &temp, e))?;
        file.write_all(bytes).map_err(|e| FileError::io("写入临时文件", &temp, e))?;
        file.sync_all().map_err(|e| FileError::io("同步临时文件", &temp, e))?;
        drop(file);
        if let Some(expected) = expected {
            let current = fs::read(path).map_err(|e| FileError::io("替换前复查文件", path, e))?;
            if fingerprint(&current) != expected {
                return Err(FileError { kind: "conflict", message: "写入临时文件期间，磁盘文件又被其他程序修改".into() });
            }
        }
        if existing {
            replace_existing(&temp, path).map_err(|e| FileError::io("替换原文件", path, e))
        } else {
            fs::rename(&temp, path).map_err(|e| FileError::io("建立文件", path, e))
        }
    })();
    if result.is_err() && (!existing || path.exists()) { let _ = fs::remove_file(&temp); }
    result
}

pub fn save(path: &Path, expected: &str, bytes: &[u8], force: bool) -> Result<SavedDocument, FileError> {
    let existing = match fs::read(path) {
        Ok(current) => {
            if !force && fingerprint(&current) != expected {
                return Err(FileError { kind: "conflict", message: "磁盘文件已被其他程序修改".into() });
            }
            if current == bytes { return Ok(SavedDocument { fingerprint: fingerprint(bytes) }); }
            true
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if !force && !expected.is_empty() {
                return Err(FileError { kind: "conflict", message: "原文件已从磁盘移走或删除".into() });
            }
            false
        }
        Err(e) => return Err(FileError::io("保存前读取文件", path, e)),
    };
    if existing {
        let metadata = fs::metadata(path).map_err(|e| FileError::io("检查文件属性", path, e))?;
        if metadata.permissions().readonly() {
            return Err(FileError { kind: "permission_denied", message: format!("文件为只读：{}", path.display()) });
        }
    }
    write_atomic(path, bytes, existing, if existing && !force { Some(expected) } else { None })?;
    Ok(SavedDocument { fingerprint: fingerprint(bytes) })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub path: String,
    pub fingerprint: String,
    pub source: String,
    pub visual_state: Option<serde_json::Value>,
    pub unsafe_visual: bool,
    pub saved_at: String,
}

pub fn recovery_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join("recovery").join(format!("{}.json", fingerprint(key.as_bytes())))
}

pub fn write_recovery(data_dir: &Path, key: &str, snapshot: &RecoverySnapshot) -> Result<(), FileError> {
    let path = recovery_path(data_dir, key);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| FileError::io("建立恢复目录", &path, e))?;
    let bytes = serde_json::to_vec(snapshot).map_err(|e| FileError { kind: "io", message: format!("编码恢复快照失败：{e}") })?;
    write_atomic(&path, &bytes, path.exists(), None)
}

pub fn read_recovery(data_dir: &Path, key: &str) -> Result<Option<RecoverySnapshot>, FileError> {
    let path = recovery_path(data_dir, key);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| FileError { kind: "io", message: format!("恢复快照损坏：{e}") }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(FileError::io("读取恢复快照", &path, e)),
    }
}

pub fn delete_recovery(data_dir: &Path, key: &str) -> Result<(), FileError> {
    let path = recovery_path(data_dir, key);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(FileError::io("删除恢复快照", &path, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn long_paths_allow_atomic_replacement_and_repeated_recovery() {
        let root = std::env::temp_dir().join(format!("mintdown-d3-long-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        let mut nested = root.clone();
        while nested.as_os_str().len() < 290 { nested = nested.join("中文 空格-long-path-segment"); }
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("正文.md");
        fs::write(&path, b"original").unwrap();
        save(&path, &fingerprint(b"original"), b"changed", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"changed");
        let mut snapshot = RecoverySnapshot { path: path.to_string_lossy().into_owned(), fingerprint: "base".into(), source: "first".into(), visual_state: None, unsafe_visual: false, saved_at: "D3".into() };
        write_recovery(&nested, "d3", &snapshot).unwrap();
        snapshot.source = "second".into();
        write_recovery(&nested, "d3", &snapshot).unwrap();
        assert_eq!(read_recovery(&nested, "d3").unwrap().unwrap().source, "second");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replacing_existing_file_and_conflict() {
        let root = std::env::temp_dir().join(format!("markdown-editor-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let path = root.join("中文 空格.md");
        let old = b"\xef\xbb\xbfhello\r\n";
        fs::write(&path, old).unwrap();
        let opened = open(&path).unwrap();
        save(&path, &opened.fingerprint, old, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), old);
        let new = b"\xef\xbb\xbfhello\r\nworld\r\n";
        save(&path, &opened.fingerprint, new, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), new);
        assert_eq!(save(&path, &opened.fingerprint, b"bad", false).unwrap_err().kind, "conflict");
        assert_eq!(fs::read(&path).unwrap(), new);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readonly_file_stays_intact_after_save_failure() {
        let root = std::env::temp_dir().join(format!("markdown-readonly-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let path = root.join("只读.md");
        fs::write(&path, b"original").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let error = save(&path, &fingerprint(b"original"), b"changed", false).unwrap_err();
        assert_eq!(error.kind, "permission_denied");
        assert_eq!(fs::read(&path).unwrap(), b"original");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violation_does_not_damage_original() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("markdown-sharing-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let path = root.join("占用.md");
        fs::write(&path, b"original").unwrap();
        // Allow reads/writes but deny FILE_SHARE_DELETE, which ReplaceFileW requires.
        let hold = OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(&path).unwrap();
        assert!(save(&path, &fingerprint(b"original"), b"changed", false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        drop(hold);
        save(&path, &fingerprint(b"original"), b"changed", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"changed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_round_trip_and_cleanup() {
        let root = std::env::temp_dir().join(format!("markdown-recovery-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        let snapshot = RecoverySnapshot { path: "中文.md".into(), fingerprint: "old".into(), source: "draft".into(), visual_state: Some(serde_json::json!({"type":"doc"})), unsafe_visual: true, saved_at: "2026-10-23T00:00:00Z".into() };
        write_recovery(&root, "中文.md", &snapshot).unwrap();
        assert_eq!(read_recovery(&root, "中文.md").unwrap().unwrap().source, "draft");
        delete_recovery(&root, "中文.md").unwrap();
        assert!(read_recovery(&root, "中文.md").unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
