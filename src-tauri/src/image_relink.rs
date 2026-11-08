use crate::file_io::FileError;
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

fn invalid(message: &str) -> FileError { FileError { kind: "invalid_path", message: message.into() } }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkCandidate { pub path: String, pub new_url: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingImage { pub old_url: String, pub file_name: String, pub reason: String,
    pub auto_candidates: usize, pub candidates: Vec<RelinkCandidate> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkScan { pub entries: Vec<MissingImage>, pub scanned_files: usize, pub already_valid: usize }

fn remote(url: &str) -> bool {
    url.starts_with("//") || url.starts_with('#') || ["http:", "https:", "data:"].iter()
        .any(|prefix| url.to_ascii_lowercase().starts_with(prefix))
}

fn candidates(folder: &Path, files: &mut Vec<PathBuf>, visited: &mut usize) -> Result<(), FileError> {
    for entry in fs::read_dir(folder).map_err(|e| FileError::io("扫描图片目录", folder, e))? {
        *visited += 1;
        if *visited > 20_000 { return Err(invalid("选定目录超过 20000 个条目，请选择更小的目录")); }
        let entry = entry.map_err(|e| FileError::io("读取图片目录", folder, e))?;
        let kind = entry.file_type().map_err(|e| FileError::io("检查图片目录", &entry.path(), e))?;
        if kind.is_symlink() { continue; }
        if kind.is_dir() { candidates(&entry.path(), files, visited)?; }
        else if kind.is_file() { files.push(entry.path()); }
    }
    Ok(())
}

pub(crate) fn relative_url(document_folder: &Path, target: &Path) -> Result<String, FileError> {
    let source = document_folder.components().collect::<Vec<_>>();
    let destination = target.components().collect::<Vec<_>>();
    let shared = source.iter().zip(&destination).take_while(|(a, b)| a == b).count();
    if shared == 0 { return Err(invalid("图片位于不同磁盘，无法直接生成相对路径；请先复制归档")); }
    let mut parts = vec!["..".to_owned(); source.len() - shared];
    for part in &destination[shared..] {
        let text = part.as_os_str().to_str().ok_or_else(|| invalid("图片路径不是 Unicode"))?;
        parts.push(urlencoding::encode(text).into_owned());
    }
    Ok(parts.join("/"))
}

fn same_name(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    // Windows file lookup is case insensitive, but OsStr equality is not.
    left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
}

fn match_suffix(candidate: &Path, selected: &Path, original: &Path) -> bool {
    let clean = original.components().filter_map(|part| match part {
        std::path::Component::Normal(value) => Some(value.to_string_lossy().to_lowercase()),
        _ => None,
    }).collect::<Vec<_>>();
    let actual = candidate.strip_prefix(selected).unwrap_or(candidate).components()
        .filter_map(|part| match part {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_lowercase()),
            _ => None,
        }).collect::<Vec<_>>();
    actual.ends_with(&clean)
}

fn validate_image(path: &Path) -> Result<(), FileError> {
    let extension = path.extension().and_then(|part| part.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Err(invalid("仅能选择受支持的图片文件"));
    }
    let mut file = File::open(path).map_err(|e| FileError::io("读取所选图片", path, e))?;
    if file.metadata().map_err(|e| FileError::io("检查图片大小", path, e))?.len() > 20 * 1024 * 1024 {
        return Err(invalid("图片超过 20 MB 预览上限"));
    }
    let mut header = [0u8; 12];
    let count = file.read(&mut header).map_err(|e| FileError::io("读取图片内容", path, e))?;
    let recognized = crate::image_assets::raster_mime(&header[..count]);
    let expected = match extension.as_str() {
        "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"), "webp" => Some("image/webp"),
        "bmp" if header.starts_with(b"BM") => Some("image/bmp"), _ => None,
    };
    if expected.is_none() || (expected != Some("image/bmp") && recognized != expected) {
        return Err(invalid("图片文件格式与扩展名不一致或内容损坏"));
    }
    Ok(())
}

pub fn manual_candidate(document_path: &Path, style: &str, image_path: &Path) -> Result<RelinkCandidate, FileError> {
    let document = fs::canonicalize(document_path).map_err(|e| FileError::io("定位文档", document_path, e))?;
    let root = document.parent().ok_or_else(|| invalid("文档目录无效"))?;
    let image = fs::canonicalize(image_path).map_err(|e| FileError::io("定位所选图片", image_path, e))?;
    if !image.is_file() { return Err(invalid("所选路径不是图片文件")); }
    validate_image(&image)?;
    let new_url = match relative_url(root, &image) {
        Ok(mut relative) => {
            if style == "asset-relative" && !relative.starts_with("../") { relative = format!("./{relative}"); }
            relative
        },
        Err(_) => String::new(), // Cross-volume files must be archived before changing Markdown.
    };
    Ok(RelinkCandidate { path: image.to_string_lossy().into_owned(), new_url })
}

pub fn scan(document_path: &Path, asset_folder: &Path, style: &str, selected_folder: &Path,
    urls: &[String], preview_failed_urls: &[String]) -> Result<RelinkScan, FileError> {
    let document = fs::canonicalize(document_path).map_err(|e| FileError::io("定位文档", document_path, e))?;
    let root = document.parent().ok_or_else(|| invalid("文档目录无效"))?;
    let selected = fs::canonicalize(selected_folder).map_err(|e| FileError::io("定位所选目录", selected_folder, e))?;
    if !selected.is_dir() { return Err(invalid("请选择图片目录")); }
    let mut files = Vec::new();
    candidates(&selected, &mut files, &mut 0)?;
    let mut missing = Vec::new();
    let mut already_valid = 0;
    for url in urls {
        if remote(url) { continue; }
        let decoded = match urlencoding::decode(url) { Ok(value) => value, Err(_) => {
            missing.push(MissingImage { old_url: url.clone(), file_name: url.clone(), reason: "图片引用的 URL 编码无效".into(), auto_candidates: 0, candidates: Vec::new() }); continue;
        }};
        let original = Path::new(decoded.as_ref());
        let existing = if original.is_absolute() { original.to_path_buf() } else { root.join(original) };
        let existing = if existing.is_file() { Some(existing) } else if style == "asset-relative" &&
            !decoded.starts_with("./") && !decoded.starts_with("../") && asset_folder.join(original).is_file() {
            Some(asset_folder.join(original))
        } else { None };
        let invalid_existing = if let Some(path) = &existing {
            match validate_image(path) {
                Ok(()) => false,
                Err(error) if error.kind == "invalid_path" => true,
                Err(error) => return Err(error),
            }
        } else { false };
        let decoder_failed = preview_failed_urls.contains(&format!("decode:{url}"));
        let preview_failed = decoder_failed || preview_failed_urls.contains(url);
        if existing.is_some() && !preview_failed && !invalid_existing { already_valid += 1; continue; }
        let name = match original.file_name() { Some(value) => value, None => {
            missing.push(MissingImage { old_url: url.clone(), file_name: decoded.into_owned(), reason: "图片引用中没有文件名".into(), auto_candidates: 0, candidates: Vec::new() }); continue;
        }};
        let mut matches: Vec<&PathBuf> = files.iter().filter(|path| path.file_name().is_some_and(|part| same_name(part, name))).collect();
        // Prefer the original subdirectory structure, then fall back to unique basename.
        if original.components().count() > 1 {
            let exact: Vec<&PathBuf> = matches.iter().copied().filter(|path| match_suffix(path, &selected, original)).collect();
            if !exact.is_empty() { matches = exact; }
        }
        let had_names = !matches.is_empty();
        let mut choices = Vec::new();
        for path in matches {
            match manual_candidate(&document, style, path) {
                Ok(candidate) => choices.push(candidate),
                Err(error) if error.kind == "invalid_path" => {},
                Err(error) => return Err(error),
            }
        }
        let reason = if invalid_existing { "原文件存在，但图片格式无效或内容损坏（无法解码）" }
            else if decoder_failed { "原文件存在，但图片无法解码；请确认图片内容" }
            else if existing.is_some() && preview_failed { "原文件可读取，但 WebView2 预览加载失败；已尝试重新读取，请检查图片解码或预览环境" }
            else if had_names && choices.is_empty() { "找到同名文件，但图片格式无效或内容损坏" }
            else if choices.is_empty() { "所选目录及子目录没有同名图片" }
            else if choices.len() > 1 { "找到多个同名图片，需要手动选择" } else { "找到唯一同名图片" };
        missing.push(MissingImage { old_url: url.clone(), file_name: name.to_string_lossy().into_owned(), reason: reason.into(),
            auto_candidates: choices.len(), candidates: choices });
    }
    Ok(RelinkScan { entries: missing, scanned_files: files.len(), already_valid })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifies_unique_ambiguous_and_unchanged() {
        let root = std::env::temp_dir().join(format!("mintdown-relink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("picked/a")).unwrap();
        fs::create_dir_all(root.join("picked/b")).unwrap();
        fs::write(root.join("article.md"), "x").unwrap();
        fs::write(root.join("picked/a/one.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        fs::write(root.join("picked/a/two.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        fs::write(root.join("picked/b/two.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        let result = scan(&root.join("article.md"), &root.join("assets"), "relative", &root.join("picked"),
            &["gone/one.png".into(), "two.png".into(), "lost.png".into(), "https://example.com/a.png".into()], &[]).unwrap();
        assert_eq!(result.entries.len(), 3);
        assert_eq!(result.entries[0].candidates.len(), 1);
        assert_eq!(result.entries[1].candidates.len(), 2);
        assert_eq!(result.entries[2].candidates.len(), 0);
        assert_eq!(result.entries[0].candidates[0].new_url, "picked/a/one.png");
        let asset_result = scan(&root.join("article.md"), &root.join("assets"), "asset-relative", &root.join("picked"), &["one.png".into()], &[]).unwrap();
        assert_eq!(asset_result.entries[0].candidates[0].new_url, "./picked/a/one.png");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_root_nested_and_windows_case_with_relative_paths() {
        let root = std::env::temp_dir().join(format!("mintdown-relink-cases-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("selected/nested/深层")).unwrap();
        fs::write(root.join("article.md"), "x").unwrap();
        fs::write(root.join("selected/Image One.PNG"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        fs::write(root.join("selected/nested/深层/中文 图片.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        let result = scan(&root.join("article.md"), &root.join("assets"), "relative", &root.join("selected"), &[
            "../other/image%20one.png".into(), "./missing/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png".into(),
            "different.png".into(),
        ], &[]).unwrap();
        assert_eq!(result.scanned_files, 2);
        assert_eq!(result.entries[0].candidates.len(), 1);
        assert_eq!(result.entries[0].candidates[0].new_url, "selected/Image%20One.PNG");
        assert_eq!(result.entries[1].candidates.len(), 1);
        assert_eq!(result.entries[1].candidates[0].new_url, "selected/nested/%E6%B7%B1%E5%B1%82/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png");
        assert_eq!(result.entries[2].candidates.len(), 0);
        assert_eq!(result.entries[2].reason, "所选目录及子目录没有同名图片");
        let manual = manual_candidate(&root.join("article.md"), "relative", &root.join("selected/Image One.PNG")).unwrap();
        assert_eq!(manual.new_url, "selected/Image%20One.PNG");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn distinguishes_valid_existing_from_unrenderable_existing() {
        let root = std::env::temp_dir().join(format!("mintdown-relink-preview-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("picked")).unwrap();
        fs::write(root.join("article.md"), "x").unwrap();
        fs::write(root.join("good.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        fs::write(root.join("bad.png"), "not a png").unwrap();
        fs::write(root.join("picked/bad.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        let report = scan(&root.join("article.md"), &root.join("assets"), "relative", &root.join("picked"),
            &["good.png".into(), "bad.png".into()], &[]).unwrap();
        assert_eq!(report.already_valid, 1);
        assert_eq!(report.entries.len(), 1);
        assert!(report.entries[0].reason.contains("内容损坏"));
        assert_eq!(report.entries[0].candidates[0].new_url, "picked/bad.png");
        let failed_preview = scan(&root.join("article.md"), &root.join("assets"), "relative", &root.join("picked"),
            &["good.png".into()], &["good.png".into()]).unwrap();
        assert_eq!(failed_preview.already_valid, 0);
        assert!(failed_preview.entries[0].reason.contains("预览加载失败"));
        let truly_missing = scan(&root.join("article.md"), &root.join("assets"), "relative", &root.join("picked"),
            &["missing.png".into()], &["missing.png".into()]).unwrap();
        assert!(truly_missing.entries[0].reason.contains("没有同名图片"));
        fs::remove_dir_all(root).unwrap();
    }
}
