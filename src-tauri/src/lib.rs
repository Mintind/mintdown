mod file_io;
mod image_assets;
mod image_relink;
mod session_store;
mod export;

use file_io::{FileError, OpenedDocument, RecoverySnapshot, SavedDocument};
use session_store::{SessionManifest, WindowSession};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct OpenDocuments(Mutex<HashMap<String, DocumentOwner>>);
#[derive(Default)]
struct PendingOpens(Mutex<HashMap<String, Vec<String>>>);
#[derive(Default)]
struct SessionStore(Mutex<SessionManifest>);
#[derive(Default)]
struct PendingImageCopies(Mutex<HashMap<String, ImageCopyFiles>>);
#[derive(Default)]
struct PendingMoves(Mutex<HashMap<String, PendingMove>>);
struct ImageCopyFiles { created: Vec<PathBuf>, draft_originals: Vec<PathBuf> }
struct PendingMove { source: PathBuf, target: PathBuf, expected: String, assets: image_assets::PreparedMove,
    template: String, style: String, urls: Vec<String>, target_exists: bool }
#[derive(Clone)]
struct DocumentOwner { window: String, tab: String }
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
static NEXT_ASSET_COPY: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCopyPlan { token: String, references: Vec<image_assets::CopiedReference>, unresolved: Vec<String> }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedAsDocument { fingerprint: String, path: String }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MovePlan { token: String, references: Vec<image_assets::CopiedReference>, unresolved: Vec<String>,
    resource_targets: Vec<String>, resource_operations: Vec<image_assets::MoveResourceOperation>, target_exists: bool }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedDocument { fingerprint: String, path: String, warning: Option<String> }

fn document_identity(path: &Path) -> Result<String, String> {
    let absolute = if path.exists() {
        std::fs::canonicalize(path)
    } else {
        let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
        std::fs::canonicalize(parent).map(|parent| parent.join(path.file_name().unwrap_or_default()))
    }.map_err(|e| format!("无法定位 {}：{e}", path.display()))?;
    Ok(absolute.to_string_lossy().replace('/', "\\").to_lowercase())
}

fn app_data(app: &AppHandle) -> Result<PathBuf, FileError> {
    // Legacy development builds used the identifier root. Leave their settings
    // and recovery files untouched; installed releases have a stable subprofile.
    app.path().app_data_dir().map(|root| root.join("stable-v1"))
        .map_err(|e| FileError { kind: "io", message: format!("无法定位应用数据目录：{e}") })
}

fn webview_data(app: &AppHandle) -> Result<PathBuf, String> {
    if background_interaction_test() && !installed_profile_test() { return session_data(app).map(|root| root.join("webview2")).map_err(|e| e.message); }
    app.path().app_local_data_dir().map(|root| root.join("stable-v1").join("webview2"))
        .map_err(|e| format!("无法定位 WebView2 数据目录：{e}"))
}

fn session_data(app: &AppHandle) -> Result<PathBuf, FileError> {
    if background_interaction_test() && !installed_profile_test() {
        let identity = std::env::var("MINTDOWN_TEST_SESSION_ID")
            .unwrap_or_else(|_| format!("process-{}", std::process::id()));
        return Ok(std::env::temp_dir().join(format!("mintdown-native-session-{}", file_io::fingerprint(identity.as_bytes()))));
    }
    app_data(app)
}

#[tauri::command]
fn read_window_session(app: AppHandle, key: String) -> Result<Option<WindowSession>, FileError> {
    let state = app.state::<SessionStore>();
    let manifest = state.0.lock().map_err(|_| FileError { kind: "io", message: "会话状态不可用".into() })?;
    Ok(manifest.windows.iter().find(|window| window.key == key).cloned())
}

#[tauri::command]
fn take_pending_open_requests(app: AppHandle, label: String) -> Result<Vec<String>, FileError> {
    let state = app.state::<PendingOpens>();
    let mut pending = state.0.lock().map_err(|_| FileError { kind: "io", message: "待打开文件队列不可用".into() })?;
    Ok(pending.remove(&label).unwrap_or_default())
}

fn queue_open_request(app: &AppHandle, label: &str, path: &Path) -> Result<(), String> {
    let state = app.state::<PendingOpens>();
    let mut pending = state.0.lock().map_err(|_| "待打开文件队列不可用".to_owned())?;
    let path = path.to_string_lossy().into_owned();
    let queued = pending.entry(label.to_owned()).or_default();
    if !queued.iter().any(|item| item.eq_ignore_ascii_case(&path)) { queued.push(path); }
    Ok(())
}

#[tauri::command]
fn save_window_session(app: AppHandle, session: WindowSession, restore_on_startup: bool) -> Result<(), FileError> {
    if session.key.is_empty() || session.tabs.len() > 200 || session.tabs.iter().any(|tab| {
        tab.id.is_empty() || tab.path.as_ref().is_some_and(|path| path.len() > 32768) ||
            !tab.scroll_top.is_finite() || tab.scroll_top < 0.0
    }) {
        return Err(FileError { kind: "invalid_path", message: "会话状态无效".into() });
    }
    let state = app.state::<SessionStore>();
    let mut current = state.0.lock().map_err(|_| FileError { kind: "io", message: "会话状态不可用".into() })?;
    let mut next = current.clone();
    next.restore_on_startup = restore_on_startup;
    if let Some(saved) = next.windows.iter_mut().find(|window| window.key == session.key) { *saved = session; }
    else { next.windows.push(session); }
    session_store::save(&session_data(&app)?, &next)?;
    *current = next;
    Ok(())
}

#[tauri::command]
fn open_document(path: String) -> Result<OpenedDocument, FileError> {
    file_io::open(Path::new(&path))
}

#[tauri::command]
fn save_document(path: String, expected_fingerprint: String, bytes: Vec<u8>, force: bool) -> Result<SavedDocument, FileError> {
    file_io::save(Path::new(&path), &expected_fingerprint, &bytes, force)
}

#[tauri::command]
fn save_document_as(app: AppHandle, current_window_label: String, current_tab_id: String, path: String, bytes: Vec<u8>, force: bool) -> Result<SavedAsDocument, FileError> {
    if app.get_webview_window(&current_window_label).is_none() {
        return Err(FileError { kind: "invalid_path", message: "当前文档窗口已关闭".into() });
    }
    let identity = document_identity(Path::new(&path)).map_err(|message| FileError { kind: "invalid_path", message })?;
    let registry = app.state::<OpenDocuments>();
    let mut owners = registry.0.lock().map_err(|_| FileError { kind: "io", message: "文档登记表不可用".into() })?;
    if let Some(owner) = owners.get(&identity) {
        if owner.tab != current_tab_id && app.get_webview_window(&owner.window).is_some() {
            return Err(FileError { kind: "already_open", message: "目标文件已在其他标签或窗口打开，请先关闭该会话".into() });
        }
    }
    let saved = file_io::save(Path::new(&path), "", &bytes, force)?;
    let canonical_path = std::fs::canonicalize(&path).map_err(|e| FileError { kind: "io", message: format!("文件已写入但定位新路径失败：{e}") })?;
    owners.retain(|_, owner| !(owner.window == current_window_label && owner.tab == current_tab_id));
    owners.insert(identity, DocumentOwner { window: current_window_label, tab: current_tab_id });
    Ok(SavedAsDocument { fingerprint: saved.fingerprint, path: canonical_path.to_string_lossy().into_owned() })
}

#[tauri::command]
fn prepare_document_move(app: AppHandle, source_path: String, target_path: String, expected_fingerprint: String,
    directory_template: String, reference_style: String, urls: Vec<String>) -> Result<MovePlan, FileError> {
    let source = std::fs::canonicalize(&source_path).map_err(|e| FileError::io("定位原文档", Path::new(&source_path), e))?;
    let target = PathBuf::from(target_path);
    if document_identity(&source).map_err(|message| FileError { kind: "invalid_path", message })? ==
        document_identity(&target).map_err(|message| FileError { kind: "invalid_path", message })? {
        return Err(FileError { kind: "invalid_path", message: "新旧路径相同".into() });
    }
    let current = std::fs::read(&source).map_err(|e| FileError::io("读取原文档", &source, e))?;
    if file_io::fingerprint(&current) != expected_fingerprint {
        return Err(FileError { kind: "conflict", message: "原文件已被其他程序修改".into() });
    }
    let assets = image_assets::preview_move(&source, &target, &directory_template, &reference_style, &urls)?;
    let target_exists = target.exists();
    let token = format!("move-{}-{}", std::process::id(), NEXT_ASSET_COPY.fetch_add(1, Ordering::Relaxed));
    let result = MovePlan { token: token.clone(), references: assets.references.clone(), unresolved: assets.unresolved.clone(),
        resource_targets: assets.planned_targets.iter().map(|path| path.to_string_lossy().into_owned()).collect(),
        resource_operations: assets.resource_operations.clone(), target_exists };
    app.state::<PendingMoves>().0.lock().map_err(|_| FileError { kind: "io", message: "迁移记录不可用".into() })?
        .insert(token, PendingMove { source, target, expected: expected_fingerprint, assets,
            template: directory_template, style: reference_style, urls, target_exists });
    Ok(result)
}

#[tauri::command]
fn cancel_document_move(app: AppHandle, token: String) -> Result<(), FileError> {
    let pending = app.state::<PendingMoves>().0.lock().map_err(|_| FileError { kind: "io", message: "迁移记录不可用".into() })?
        .remove(&token).ok_or_else(|| FileError { kind: "invalid_path", message: "迁移记录不存在".into() })?;
    // Preview is read-only; there are no staged image files to remove.
    let _ = pending;
    Ok(())
}

#[tauri::command]
fn finish_document_move(app: AppHandle, current_window_label: String, current_tab_id: String,
    token: String, bytes: Vec<u8>, overwrite: bool) -> Result<MovedDocument, FileError> {
    let pending = app.state::<PendingMoves>().0.lock().map_err(|_| FileError { kind: "io", message: "迁移记录不可用".into() })?
        .remove(&token).ok_or_else(|| FileError { kind: "invalid_path", message: "迁移记录不存在".into() })?;
    let PendingMove { source, target, expected, assets: preview, template, style, urls, target_exists } = pending;
    if target.exists() != target_exists {
        return Err(FileError { kind: "conflict", message: "目标文件状态已变化，请重新确认迁移计划".into() });
    }
    let assets = image_assets::prepare_move(&source, &target, &template, &style, &urls)?;
    if assets.references != preview.references || assets.unresolved != preview.unresolved ||
        assets.planned_targets != preview.planned_targets || assets.resource_operations != preview.resource_operations {
        for path in &assets.created { let _ = std::fs::remove_file(path); }
        return Err(FileError { kind: "conflict", message: "图片资源状态已变化，请重新确认迁移计划".into() });
    }
    let result = (|| -> Result<MovedDocument, FileError> {
        let source_now = std::fs::read(&source).map_err(|e| FileError::io("移动前读取原文档", &source, e))?;
        if file_io::fingerprint(&source_now) != expected {
            return Err(FileError { kind: "conflict", message: "准备迁移期间原文件被修改".into() });
        }
        let identity = document_identity(&target).map_err(|message| FileError { kind: "invalid_path", message })?;
        let registry = app.state::<OpenDocuments>();
        let mut owners = registry.0.lock().map_err(|_| FileError { kind: "io", message: "文档登记表不可用".into() })?;
        if let Some(owner) = owners.get(&identity) {
            if owner.tab != current_tab_id && app.get_webview_window(&owner.window).is_some() {
                return Err(FileError { kind: "already_open", message: "目标文件已在其他标签或窗口打开".into() });
            }
        }
        let previous_target = if target.exists() {
            if !overwrite { return Err(FileError { kind: "conflict", message: "目标文件已存在，需明确确认覆盖".into() }); }
            Some(std::fs::read(&target).map_err(|e| FileError::io("备份目标文件", &target, e))?)
        } else { None };
        file_io::save(&target, previous_target.as_ref().map(|bytes| file_io::fingerprint(bytes)).as_deref().unwrap_or(""), &bytes, false)?;
        let target_now = std::fs::read(&target).map_err(|e| FileError::io("校验目标文件", &target, e))?;
        if target_now != bytes || file_io::fingerprint(&std::fs::read(&source).map_err(|e| FileError::io("复查原文档", &source, e))?) != expected {
            if let Some(original) = previous_target { let _ = file_io::write_atomic(&target, &original, true, None); }
            else { let _ = std::fs::remove_file(&target); }
            return Err(FileError { kind: "conflict", message: "迁移校验失败或原文档已变化，已尝试回滚目标文件".into() });
        }
        let canonical = std::fs::canonicalize(&target).map_err(|e| FileError::io("定位新文档", &target, e))?;
        if let Err(error) = std::fs::remove_file(&source) {
            if let Some(original) = previous_target { let _ = file_io::write_atomic(&target, &original, true, None); }
            else { let _ = std::fs::remove_file(&target); }
            return Err(FileError::io("移除原文档", &source, error));
        }
        let warning = image_assets::cleanup_old_assets(&assets);
        owners.retain(|_, owner| !(owner.window == current_window_label && owner.tab == current_tab_id));
        owners.insert(identity, DocumentOwner { window: current_window_label, tab: current_tab_id });
        Ok(MovedDocument { fingerprint: file_io::fingerprint(&bytes), path: canonical.to_string_lossy().into_owned(), warning })
    })();
    if result.is_err() { for path in assets.created { let _ = std::fs::remove_file(path); } }
    result
}

#[tauri::command]
fn register_document_tab(app: AppHandle, current_window_label: String, tab_id: String, path: String) -> Result<(), FileError> {
    let identity = document_identity(Path::new(&path)).map_err(|message| FileError { kind: "invalid_path", message })?;
    let registry = app.state::<OpenDocuments>();
    let mut owners = registry.0.lock().map_err(|_| FileError { kind: "io", message: "文档登记表不可用".into() })?;
    if let Some(owner) = owners.get(&identity) {
        if owner.tab != tab_id && !(owner.tab.is_empty() && owner.window == current_window_label) && app.get_webview_window(&owner.window).is_some() {
            return Err(FileError { kind: "already_open", message: "文件已在其他标签或窗口打开".into() });
        }
    }
    owners.insert(identity, DocumentOwner { window: current_window_label, tab: tab_id });
    Ok(())
}

#[tauri::command]
fn release_document_tab(app: AppHandle, current_window_label: String, tab_id: String) -> Result<(), FileError> {
    let registry = app.state::<OpenDocuments>();
    let mut owners = registry.0.lock().map_err(|_| FileError { kind: "io", message: "文档登记表不可用".into() })?;
    owners.retain(|_, owner| !(owner.window == current_window_label && owner.tab == tab_id));
    Ok(())
}

#[tauri::command]
fn load_recovery(app: AppHandle, key: String) -> Result<Option<RecoverySnapshot>, FileError> {
    file_io::read_recovery(&session_data(&app)?, &key)
}

#[tauri::command]
fn save_recovery(app: AppHandle, key: String, snapshot: RecoverySnapshot) -> Result<(), FileError> {
    file_io::write_recovery(&session_data(&app)?, &key, &snapshot)
}

#[tauri::command]
fn clear_recovery(app: AppHandle, key: String) -> Result<(), FileError> {
    file_io::delete_recovery(&session_data(&app)?, &key)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentImage {
    mime: &'static str,
    bytes: Vec<u8>,
}

#[tauri::command]
fn read_document_image(document_path: String, image_path: String) -> Result<DocumentImage, FileError> {
    let invalid = |message: &str| FileError { kind: "invalid_path", message: message.into() };
    if image_path.contains('\0') || image_path.contains("://") {
        return Err(invalid("图片路径格式不受支持"));
    }
    let document = std::fs::canonicalize(&document_path).map_err(|e| FileError::io("定位文档", Path::new(&document_path), e))?;
    let folder = document.parent().ok_or_else(|| invalid("无法定位文档目录"))?;
    let candidate = folder.join(&image_path);
    let path = std::fs::canonicalize(&candidate).map_err(|e| FileError::io("定位图片", &candidate, e))?;
    if !path.is_file() { return Err(invalid("图片路径不是文件")); }
    let mime = match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
        "webp" => "image/webp", "bmp" => "image/bmp", _ => return Err(invalid("图片格式不受支持")),
    };
    let size = path.metadata().map_err(|e| FileError::io("检查图片", &path, e))?.len();
    if size > 20 * 1024 * 1024 { return Err(invalid("图片超过 20 MB 预览上限")); }
    let bytes = std::fs::read(&path).map_err(|e| FileError::io("读取图片", &path, e))?;
    let valid_header = if mime == "image/bmp" { bytes.starts_with(b"BM") }
        else { image_assets::raster_mime(&bytes) == Some(mime) };
    if !valid_header { return Err(FileError { kind: "invalid_image", message: format!("图片无法解码：{} 的格式与内容不一致或文件已损坏", path.display()) }); }
    Ok(DocumentImage { mime, bytes })
}

#[tauri::command]
fn reveal_document_in_explorer(path: String) -> Result<(), FileError> {
    let file = std::fs::canonicalize(&path).map_err(|e| FileError::io("定位文档", Path::new(&path), e))?;
    if !file.is_file() { return Err(FileError { kind: "invalid_path", message: "文档路径不是文件".into() }); }
    #[cfg(windows)]
    {
        if !background_interaction_test() {
            let raw = file.to_string_lossy();
            let visible = raw.strip_prefix(r"\\?\UNC\").map(|rest| format!(r"\\{rest}"))
                .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_owned))
                .unwrap_or_else(|| raw.into_owned());
            std::process::Command::new("explorer.exe").arg(format!("/select,{visible}"))
                .spawn().map_err(|e| FileError::io("在资源管理器中显示", &file, e))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn scan_missing_images(document_path: String, directory_template: String, reference_style: String,
    selected_folder: String, urls: Vec<String>, preview_failed_urls: Vec<String>) -> Result<image_relink::RelinkScan, FileError> {
    if !matches!(reference_style.as_str(), "relative" | "asset-relative") {
        return Err(FileError { kind: "invalid_path", message: "图片引用格式无效".into() });
    }
    let name = Path::new(&document_path).file_stem().and_then(|value| value.to_str()).unwrap_or("untitled");
    let parts = image_assets::directory_parts(&directory_template, name)?;
    let assets = Path::new(&document_path).parent().unwrap_or(Path::new(".")).join(parts.join("/"));
    image_relink::scan(Path::new(&document_path), &assets, &reference_style, Path::new(&selected_folder), &urls, &preview_failed_urls)
}

#[tauri::command]
fn choose_relink_image(document_path: String, reference_style: String, image_path: String)
    -> Result<image_relink::RelinkCandidate, FileError> {
    if !matches!(reference_style.as_str(), "relative" | "asset-relative") {
        return Err(FileError { kind: "invalid_path", message: "图片引用格式无效".into() });
    }
    image_relink::manual_candidate(Path::new(&document_path), &reference_style, Path::new(&image_path))
}

#[tauri::command]
fn preview_relink_archives(document_path: String, directory_template: String,
    reference_style: String, selected: Vec<(String, String)>) -> Result<image_assets::RelinkArchivePlan, FileError> {
    image_assets::plan_selected_relinks(Path::new(&document_path), &directory_template, &reference_style, &selected)
}

#[tauri::command]
fn stage_relink_archives(app: AppHandle, document_path: String, directory_template: String,
    reference_style: String, selected: Vec<(String, String)>) -> Result<ImageCopyPlan, FileError> {
    let (references, created) = image_assets::archive_selected_relinks(Path::new(&document_path),
        &directory_template, &reference_style, &selected)?;
    let token = format!("relink-{}-{}", std::process::id(), NEXT_ASSET_COPY.fetch_add(1, Ordering::Relaxed));
    match app.state::<PendingImageCopies>().0.lock() {
        Ok(mut pending) => { pending.insert(token.clone(), ImageCopyFiles { created, draft_originals: Vec::new() }); },
        Err(_) => {
            for path in created { let _ = std::fs::remove_file(path); }
            return Err(FileError { kind: "io", message: "图片复制记录不可用".into() });
        },
    }
    Ok(ImageCopyPlan { token, references, unresolved: Vec::new() })
}

#[tauri::command]
fn archive_document_image(app: AppHandle, document_path: Option<String>, session_id: String,
    directory_template: String, reference_style: String, original_name: String, bytes: Vec<u8>)
    -> Result<image_assets::ArchivedImage, FileError> {
    image_assets::archive(&session_data(&app)?, document_path.as_deref().map(Path::new),
        &session_id, &directory_template, &reference_style, &original_name, &bytes)
}

#[tauri::command]
fn archive_local_image(app: AppHandle, document_path: Option<String>, session_id: String,
    directory_template: String, reference_style: String, source_path: String)
    -> Result<image_assets::ArchivedImage, FileError> {
    let source = std::fs::canonicalize(&source_path).map_err(|e| FileError::io("定位所选图片", Path::new(&source_path), e))?;
    let metadata = source.metadata().map_err(|e| FileError::io("检查所选图片", &source, e))?;
    if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 {
        return Err(FileError { kind: "invalid_path", message: "所选图片无效或超过 20 MB".into() });
    }
    let bytes = std::fs::read(&source).map_err(|e| FileError::io("读取所选图片", &source, e))?;
    image_assets::archive(&session_data(&app)?, document_path.as_deref().map(Path::new),
        &session_id, &directory_template, &reference_style,
        source.file_name().and_then(|name| name.to_str()).unwrap_or("image"), &bytes)
}

#[tauri::command]
fn read_draft_document_image(app: AppHandle, session_id: String, image_path: String) -> Result<DocumentImage, FileError> {
    let bytes = image_assets::read_draft(&session_data(&app)?, &session_id, &image_path)?;
    let mime = image_assets::raster_mime(&bytes).ok_or_else(|| FileError { kind: "invalid_path", message: "临时图片格式无效".into() })?;
    Ok(DocumentImage { mime, bytes })
}

#[tauri::command]
fn copy_document_images(app: AppHandle, source_document: Option<String>, session_id: String,
    target_document: String, directory_template: String, reference_style: String, urls: Vec<String>)
    -> Result<ImageCopyPlan, FileError> {
    let (references, created, draft_originals, unresolved) = image_assets::copy_referenced(&session_data(&app)?,
        source_document.as_deref().map(Path::new), &session_id, Path::new(&target_document),
        &directory_template, &reference_style, &urls)?;
    let token = format!("{}-{}", std::process::id(), NEXT_ASSET_COPY.fetch_add(1, Ordering::Relaxed));
    app.state::<PendingImageCopies>().0.lock().map_err(|_| FileError { kind: "io", message: "图片复制记录不可用".into() })?.insert(token.clone(), ImageCopyFiles { created, draft_originals });
    Ok(ImageCopyPlan { token, references, unresolved })
}

#[tauri::command]
fn finish_image_copies(app: AppHandle, token: String, commit: bool) -> Result<(), FileError> {
    let files = app.state::<PendingImageCopies>().0.lock().map_err(|_| FileError { kind: "io", message: "图片复制记录不可用".into() })?.remove(&token)
        .ok_or_else(|| FileError { kind: "invalid_path", message: "图片复制记录不存在".into() })?;
    if commit {
        for path in files.draft_originals { std::fs::remove_file(&path).map_err(|e| FileError::io("清理临时图片", &path, e))?; }
    } else {
        for path in files.created { std::fs::remove_file(&path).map_err(|e| FileError::io("回滚图片复制", &path, e))?; }
    }
    Ok(())
}

fn window_label(path: &Path) -> String {
    format!("file-{}", file_io::fingerprint(path.to_string_lossy().to_lowercase().as_bytes()))
}

fn background_interaction_test() -> bool {
    (cfg!(debug_assertions) || cfg!(feature = "native-test")) && std::env::var_os("MINTDOWN_TEST_BACKGROUND").is_some()
}

fn installed_profile_test() -> bool {
    cfg!(feature = "native-test") && std::env::var_os("MINTDOWN_TEST_INSTALLED_PROFILE").is_some()
}

fn test_dialogs_script() -> &'static str {
    if cfg!(feature = "native-test") && background_interaction_test() {
        "window.__MINTDOWN_TEST_DIALOGS__={ask:()=>true};"
    } else { "" }
}

#[cfg(windows)]
fn prevent_test_window_activation(window: &tauri::WebviewWindow) -> Result<(), String> {
    if !background_interaction_test() { return Ok(()); }
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    unsafe {
        let style = GetWindowLongPtrW(hwnd as _, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd as _, GWL_EXSTYLE, style | WS_EX_NOACTIVATE as isize);
    }
    Ok(())
}

#[cfg(not(windows))]
fn prevent_test_window_activation(_window: &tauri::WebviewWindow) -> Result<(), String> { Ok(()) }

#[cfg(windows)]
fn disable_browser_accelerators(window: &tauri::WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;
    window.with_webview(|webview| {
        let result = (|| -> windows_core::Result<()> {
            let settings = unsafe { webview.controller().CoreWebView2()?.Settings()? };
            let settings3 = settings.cast::<ICoreWebView2Settings3>()?;
            unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) }
        })();
        if let Err(error) = result { eprintln!("禁用浏览器保存网页快捷键失败：{error}"); }
    }).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn disable_browser_accelerators(_window: &tauri::WebviewWindow) -> Result<(), String> { Ok(()) }

fn document_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    // The pooled PDF renderer is a utility WebView, never an open-file target.
    app.webview_windows().into_values().find(|window| !window.label().starts_with("export-"))
}

fn open_or_focus_mode(app: &AppHandle, input: &Path, new_window: bool) -> Result<(), String> {
    let path = std::fs::canonicalize(input).map_err(|e| format!("无法打开 {}：{e}", input.display()))?;
    let identity = document_identity(&path)?;
    let registry = app.state::<OpenDocuments>();
    let mut owners = registry.0.lock().map_err(|_| "文档登记表不可用".to_owned())?;
    if let Some(owner) = owners.get(&identity) {
        if let Some(window) = app.get_webview_window(&owner.window) {
            queue_open_request(app, &owner.window, &path)?;
            let _ = app.emit_to(&owner.window, "open-document", path.to_string_lossy().to_string());
            if background_interaction_test() { return Ok(()); }
            let _ = window.unminimize();
            return window.set_focus().map_err(|e| e.to_string());
        }
        owners.remove(&identity);
    }
    if !new_window { if let Some(window) = document_window(app) {
        let label = window.label().to_owned();
        owners.insert(identity, DocumentOwner { window: label.clone(), tab: String::new() });
        queue_open_request(app, &label, &path)?;
        app.emit_to(&label, "open-document", path.to_string_lossy().to_string()).map_err(|e| e.to_string())?;
        if background_interaction_test() { return Ok(()); }
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    } }
    let mut label = window_label(&path);
    while app.get_webview_window(&label).is_some() {
        label = format!("{}-{}", window_label(&path), NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    }
    let path_string = path.to_string_lossy();
    let session_key = if document_window(app).is_none() { "main" } else { &label };
    let url = format!("index.html?session={}&path={}", urlencoding::encode(session_key), urlencoding::encode(&path_string));
    let mut builder = WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::App(url.into()))
        .data_directory(webview_data(app)?)
        .initialization_script(test_dialogs_script())
        .title(path.file_name().unwrap_or_default().to_string_lossy().as_ref())
        .inner_size(1024.0, 768.0);
    if background_interaction_test() {
        builder = builder.focused(false).position(-20000.0, -20000.0);
    }
    let window = builder
        .build()
        .map_err(|e| e.to_string())?;
    prevent_test_window_activation(&window)?;
    disable_browser_accelerators(&window)?;
    owners.insert(identity, DocumentOwner { window: label.clone(), tab: label });
    if background_interaction_test() { Ok(()) } else { window.set_focus().map_err(|e| e.to_string()) }
}

fn open_or_focus(app: &AppHandle, input: &Path) -> Result<(), String> {
    open_or_focus_mode(app, input, false)
}

fn open_untitled(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = document_window(app) {
        return if background_interaction_test() { Ok(()) } else { window.set_focus().map_err(|e| e.to_string()) };
    }
    let label = if background_interaction_test() {
        std::env::var("MINTDOWN_TEST_UNTITLED_LABEL").unwrap_or_else(|_| "untitled".into())
    } else { "untitled".into() };
    if let Some(window) = app.get_webview_window(&label) {
        return if background_interaction_test() { Ok(()) } else { window.set_focus().map_err(|e| e.to_string()) };
    }
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html?session=main".into()))
        .data_directory(webview_data(app)?)
        .initialization_script(test_dialogs_script())
        .title("Mintdown")
        .inner_size(1024.0, 768.0);
    if background_interaction_test() {
        builder = builder.focused(false).position(-20000.0, -20000.0);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    prevent_test_window_activation(&window)?;
    disable_browser_accelerators(&window)?;
    Ok(())
}

fn open_restored_window(app: &AppHandle, key: &str, launch_path: Option<&Path>) -> Result<(), String> {
    let label = if key == "main" {
        if background_interaction_test() {
            std::env::var("MINTDOWN_TEST_UNTITLED_LABEL").unwrap_or_else(|_| "untitled".into())
        } else { "untitled".into() }
    } else { key.to_owned() };
    let mut url = format!("index.html?session={}", urlencoding::encode(key));
    if let Some(path) = launch_path { url.push_str(&format!("&path={}", urlencoding::encode(&path.to_string_lossy()))); }
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .data_directory(webview_data(app)?)
        .initialization_script(test_dialogs_script())
        .title("Mintdown")
        .inner_size(1024.0, 768.0);
    if background_interaction_test() { builder = builder.focused(false).position(-20000.0, -20000.0); }
    let window = builder.build().map_err(|error| format!("恢复文档窗口失败：{error}"))?;
    prevent_test_window_activation(&window)?;
    disable_browser_accelerators(&window)?;
    Ok(())
}

#[tauri::command]
fn request_close_for_test(app: AppHandle, label: String) -> Result<(), String> {
    if !background_interaction_test() { return Err("仅供后台原生测试使用".into()); }
    app.get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在：{label}"))?
        .close()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_path_window(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_or_focus_mode(&app, Path::new(&path), true))
        .await
        .map_err(|e| format!("创建文档窗口失败：{e}"))?
}

#[tauri::command]
async fn open_path_tab(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_or_focus(&app, Path::new(&path)))
        .await
        .map_err(|e| format!("打开文档标签失败：{e}"))?
}

fn launch_arg(args: &[String], cwd: &Path) -> Option<PathBuf> {
    args.iter().skip(1).find(|arg| *arg != "--" && !arg.starts_with('-')).map(|arg| {
        let path = PathBuf::from(arg);
        if path.is_absolute() { path } else { cwd.join(path) }
    })
}

pub fn run() {
    tauri::Builder::default()
        .manage(OpenDocuments::default())
        .manage(PendingImageCopies::default())
        .manage(PendingMoves::default())
        .manage(PendingOpens::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let path = launch_arg(&args, Path::new(&cwd));
            if let Some(path) = path {
                if let Err(error) = open_or_focus(app, &path) {
                    eprintln!("第二次启动打开文件失败：{error}");
                    let _ = open_untitled(app);
                }
            } else {
                let _ = open_untitled(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_document, save_document, save_document_as, prepare_document_move, cancel_document_move, finish_document_move, register_document_tab, release_document_tab, read_document_image, reveal_document_in_explorer, scan_missing_images, choose_relink_image, preview_relink_archives, stage_relink_archives, archive_document_image, archive_local_image, read_draft_document_image, copy_document_images, finish_image_copies, load_recovery, save_recovery, clear_recovery, read_window_session, save_window_session, take_pending_open_requests, open_path_window, open_path_tab, request_close_for_test, export::export_target_fingerprint, export::write_export_html, export::write_export_pdf, export::read_export_image])
        .setup(|app| {
            let data_dir = session_data(app.handle()).map_err(|error| std::io::Error::other(error.message))?;
            let manifest = session_store::load(&data_dir).unwrap_or_else(|error| {
                eprintln!("上次会话状态无法读取，将从空白会话启动：{}", error.message);
                SessionManifest::default()
            });
            app.manage(SessionStore(Mutex::new(manifest.clone())));
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()?;
            let launch_path = launch_arg(&args, &cwd);
            if manifest.restore_on_startup && !manifest.windows.is_empty() {
                let mut windows = manifest.windows;
                windows.sort_by_key(|window| window.key != "main");
                for (index, window) in windows.iter().enumerate() {
                    open_restored_window(app.handle(), &window.key, if index == 0 { launch_path.as_deref() } else { None })
                        .map_err(std::io::Error::other)?;
                }
            } else if let Some(path) = launch_path {
                open_or_focus(app.handle(), &path).map_err(std::io::Error::other)?;
            } else {
                open_untitled(app.handle()).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

#[cfg(test)]
mod image_tests {
    use super::read_document_image;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn image_preview_allows_relative_parent_paths_but_only_raster_types() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("mintdown-image-{}-{unique}", std::process::id()));
        let document_dir = root.join("article");
        fs::create_dir_all(document_dir.join("assets")).unwrap();
        let document = document_dir.join("中文 空格.md");
        fs::write(&document, b"# test").unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        fs::write(document_dir.join("assets").join("a.png"), png).unwrap();
        fs::write(root.join("outside.png"), png).unwrap();
        fs::write(document_dir.join("broken.png"), [1_u8, 2, 3]).unwrap();
        fs::write(document_dir.join("unsafe.svg"), b"<svg/>").unwrap();
        let path = document.to_string_lossy().into_owned();
        let image = read_document_image(path.clone(), "assets/a.png".into()).unwrap();
        assert_eq!(image.mime, "image/png");
        assert_eq!(image.bytes, png);
        assert!(read_document_image(path.clone(), "../outside.png".into()).is_ok());
        assert_eq!(read_document_image(path.clone(), "broken.png".into()).unwrap_err().kind, "invalid_image");
        assert_eq!(read_document_image(path.clone(), "missing.png".into()).unwrap_err().kind, "not_found");
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let locked = std::fs::OpenOptions::new().read(true).share_mode(0)
                .open(document_dir.join("assets/a.png")).unwrap();
            let inaccessible = read_document_image(path.clone(), "assets/a.png".into()).unwrap_err();
            assert!(matches!(inaccessible.kind, "io" | "permission_denied"));
            assert!(inaccessible.message.contains("读取图片"));
            drop(locked);
        }
        assert!(read_document_image(path.clone(), "unsafe.svg".into()).is_err());
        assert!(read_document_image(path, "https://example.com/a.png".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
