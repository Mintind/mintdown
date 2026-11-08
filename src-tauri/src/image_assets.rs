use crate::file_io::{fingerprint, FileError};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};
use sha2::{Digest, Sha256};

fn invalid(message: &str) -> FileError { FileError { kind: "invalid_path", message: message.into() } }

fn safe_segment(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    !value.is_empty() && value != "." && value != ".." &&
        !value.ends_with(['.', ' ']) &&
        !value.chars().any(|ch| ch < ' ' || "<>:\"|?*\\/".contains(ch)) &&
        !matches!(stem, "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9")
}

pub fn directory_parts(template: &str, filename: &str) -> Result<Vec<String>, FileError> {
    if template.starts_with(['/', '\\']) || template.contains(':') || template.contains('\0') ||
        template.contains("${") && template.replace("${filename}", "").contains("${") {
        return Err(invalid("资源目录模板必须是安全的相对路径"));
    }
    let rendered = template.replace("${filename}", filename).replace('\\', "/");
    let parts: Vec<String> = rendered.split('/').map(str::to_owned).collect();
    if parts.is_empty() || parts.iter().any(|part| !safe_segment(part)) {
        return Err(invalid("资源目录含非法名称或越界路径"));
    }
    Ok(parts)
}

fn checked_directory(root: &Path, parts: &[String]) -> Result<PathBuf, FileError> {
    fs::create_dir_all(root).map_err(|e| FileError::io("创建资源根目录", root, e))?;
    let base = fs::canonicalize(root).map_err(|e| FileError::io("定位资源根目录", root, e))?;
    let mut current = base.clone();
    for part in parts {
        let next = current.join(part);
        if !next.exists() { fs::create_dir(&next).map_err(|e| FileError::io("创建资源目录", &next, e))?; }
        current = fs::canonicalize(&next).map_err(|e| FileError::io("定位资源目录", &next, e))?;
        if !current.starts_with(&base) { return Err(invalid("资源目录越出 Markdown 所在目录")); }
    }
    Ok(current)
}

fn raster_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("png") }
    else if bytes.starts_with(b"\xff\xd8\xff") { Some("jpg") }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some("gif") }
    else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" { Some("webp") }
    else { None }
}

pub fn raster_mime(bytes: &[u8]) -> Option<&'static str> {
    match raster_extension(bytes)? {
        "png" => Some("image/png"), "jpg" => Some("image/jpeg"),
        "gif" => Some("image/gif"), "webp" => Some("image/webp"), _ => None,
    }
}

fn encoded_path(parts: &[String]) -> String {
    parts.iter().map(|part| urlencoding::encode(part).into_owned()).collect::<Vec<_>>().join("/")
}

pub fn draft_root(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir.join("draft-images").join(fingerprint(session_id.as_bytes()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedImage { pub reference: String, pub name: String }

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedReference { pub old_url: String, pub new_url: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkCopy { pub source: String, pub target: String, pub reused: bool }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkArchivePlan { pub target_directory: String, pub references: Vec<CopiedReference>, pub copies: Vec<RelinkCopy> }

fn collect_directory_files(folder: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> Result<(), FileError> {
    for entry in fs::read_dir(folder).map_err(|e| FileError::io("读取图片资源目录", folder, e))? {
        let entry = entry.map_err(|e| FileError::io("读取图片资源条目", folder, e))?;
        let kind = entry.file_type().map_err(|e| FileError::io("检查图片资源条目", &entry.path(), e))?;
        if kind.is_symlink() { return Err(invalid("资源目录包含符号链接，无法安全复制整个目录")); }
        let name = entry.file_name().to_str().ok_or_else(|| invalid("资源目录含非 Unicode 文件名"))?.to_owned();
        if !safe_segment(&name) { return Err(invalid("资源目录含非法文件名")); }
        let child = relative.join(name);
        if kind.is_dir() { collect_directory_files(&entry.path(), &child, files)?; }
        else if kind.is_file() { files.push(child); }
    }
    Ok(())
}

fn file_hash(path: &Path) -> Result<String, FileError> {
    let mut file = fs::File::open(path).map_err(|e| FileError::io("校验图片资源", path, e))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| FileError::io("校验图片资源", path, e))?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn copy_unique(root: &Path, directory: &[String], original: &Path) -> Result<(PathBuf, Vec<String>), FileError> {
    let folder = checked_directory(root, directory)?;
    let source_name = original.file_name().and_then(|name| name.to_str()).ok_or_else(|| invalid("图片文件名无效"))?;
    if !safe_segment(source_name) { return Err(invalid("图片文件名无效")); }
    let source = fs::canonicalize(original).map_err(|e| FileError::io("定位原图片", original, e))?;
    let stem = Path::new(source_name).file_stem().and_then(|name| name.to_str()).unwrap_or("image");
    let extension = Path::new(source_name).extension().and_then(|name| name.to_str());
    for number in 1..=9999 {
        let name = if number == 1 { source_name.to_owned() } else if let Some(ext) = extension {
            format!("{stem}-{number}.{ext}")
        } else { format!("{stem}-{number}") };
        let target = folder.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut output) => {
                let result = (|| {
                    let mut input = fs::File::open(&source)?;
                    io::copy(&mut input, &mut output)?;
                    output.sync_all()
                })();
                if let Err(error) = result { drop(output); let _ = fs::remove_file(&target);
                    return Err(FileError::io("复制图片资源", &target, error)); }
                match (|| Ok::<bool, FileError>(file_hash(&source)? == file_hash(&target)?))() {
                    Ok(true) => {},
                    Ok(false) => { let _ = fs::remove_file(&target); return Err(invalid("图片复制后校验失败")); },
                    Err(error) => { let _ = fs::remove_file(&target); return Err(error); },
                }
                let mut target_parts = directory.to_vec();
                target_parts.push(name);
                return Ok((target, target_parts));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(FileError::io("创建图片资源", &target, error)),
        }
    }
    Err(invalid("图片资源同名冲突过多"))
}

fn local_image(source_root: &Path, assets_folder: &Path, style: &str, url: &str) -> Result<Option<PathBuf>, FileError> {
    if is_remote_reference(url) { return Ok(None); }
    let decoded = urlencoding::decode(url).map_err(|_| invalid("图片引用编码无效"))?;
    if decoded.contains('\0') { return Ok(None); }
    let relative = Path::new(decoded.as_ref());
    let mut candidates = Vec::new();
    if relative.is_absolute() { candidates.push(relative.to_path_buf()); }
    else {
        if style == "asset-relative" && !decoded.starts_with("./") && !decoded.starts_with("../") {
            candidates.push(assets_folder.join(relative));
        }
        candidates.push(source_root.join(relative));
    }
    for candidate in candidates {
        if let Ok(path) = fs::canonicalize(candidate) {
            if path.is_file() { return Ok(Some(path)); }
        }
    }
    Ok(None)
}

fn url_from_parts(parts: &[String], style: &str, asset_prefix: &[String]) -> String {
    let visible = if style == "asset-relative" && parts.starts_with(asset_prefix) { &parts[asset_prefix.len()..] } else { parts };
    encoded_path(visible)
}

fn is_remote_reference(url: &str) -> bool {
    url.starts_with("//") || url.starts_with('#') ||
        ["http:", "https:", "data:"].iter().any(|prefix| url.to_ascii_lowercase().starts_with(prefix))
}

fn draft_image(base: &Path, components: &[&str]) -> Result<Option<PathBuf>, FileError> {
    if components.is_empty() || components.iter().any(|part| !safe_segment(part)) { return Ok(None); }
    if components.len() > 1 {
        let path = match fs::canonicalize(base.join(components.join("/"))) { Ok(path) => path, Err(_) => return Ok(None) };
        return Ok((path.starts_with(base) && path.is_file()).then_some(path));
    }
    // Short asset references do not encode the folder. Accept only one exact
    // match, so a settings change cannot silently select an unrelated image.
    let mut folders = vec![base.to_path_buf()];
    let mut found = None;
    let mut visited = 0;
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).map_err(|e| FileError::io("查找临时图片", &folder, e))? {
            visited += 1;
            if visited > 10_000 { return Err(invalid("临时图片目录过大，无法安全解析短引用")); }
            let entry = entry.map_err(|e| FileError::io("读取临时图片目录", &folder, e))?;
            let kind = entry.file_type().map_err(|e| FileError::io("检查临时图片", &entry.path(), e))?;
            if kind.is_dir() { folders.push(entry.path()); }
            else if kind.is_file() && entry.file_name().to_str() == Some(components[0]) {
                if found.is_some() { return Err(invalid("多个临时图片同名，无法安全迁移短引用")); }
                found = Some(entry.path());
            }
        }
    }
    Ok(found)
}

pub fn archive(data_dir: &Path, document_path: Option<&Path>, session_id: &str, template: &str,
    reference_style: &str, original_name: &str, bytes: &[u8]) -> Result<ArchivedImage, FileError> {
    if !matches!(reference_style, "relative" | "asset-relative") { return Err(invalid("图片引用格式无效")); }
    if bytes.len() > 20 * 1024 * 1024 { return Err(invalid("图片超过 20 MB 上限")); }
    let extension = raster_extension(bytes).ok_or_else(|| invalid("仅支持 PNG、JPEG、GIF、WebP 图片"))?;
    let filename = document_path.and_then(|path| path.file_stem()).and_then(|stem| stem.to_str()).unwrap_or("untitled");
    let parts = directory_parts(template, filename)?;
    let root = match document_path {
        Some(path) => {
            let parent = path.parent().ok_or_else(|| invalid("Markdown 目录无效"))?;
            fs::canonicalize(parent).map_err(|e| FileError::io("定位 Markdown 目录", parent, e))?
        }
        None => draft_root(data_dir, session_id),
    };
    let folder = checked_directory(&root, &parts)?;
    let candidate = original_name.rsplit(['/', '\\']).next().unwrap_or("image");
    let stem = Path::new(candidate).file_stem().and_then(|value| value.to_str()).unwrap_or("image");
    let stem = if safe_segment(stem) { stem } else { "image" };
    for number in 1..=9999 {
        let name = if number == 1 { format!("{stem}.{extension}") } else { format!("{stem}-{number}.{extension}") };
        let path = folder.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                    drop(file); let _ = fs::remove_file(&path);
                    return Err(FileError::io("写入图片", &path, error));
                }
                let mut ref_parts = if reference_style == "relative" { parts.clone() } else { Vec::new() };
                ref_parts.push(name.clone());
                return Ok(ArchivedImage { reference: format!("![]({})", encoded_path(&ref_parts)), name });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(FileError::io("创建图片", &path, error)),
        }
    }
    Err(invalid("图片同名冲突过多"))
}

pub fn copy_referenced(data_dir: &Path, source_document: Option<&Path>, session_id: &str,
    target_document: &Path, template: &str, style: &str, urls: &[String])
    -> Result<(Vec<CopiedReference>, Vec<PathBuf>, Vec<PathBuf>, Vec<String>), FileError> {
    if !matches!(style, "relative" | "asset-relative") { return Err(invalid("图片引用格式无效")); }
    let old_name = source_document.and_then(|path| path.file_stem()).and_then(|name| name.to_str()).unwrap_or("untitled");
    let old_parts = directory_parts(template, old_name)?;
    let source_root = match source_document {
        Some(path) => {
            let document = fs::canonicalize(path).map_err(|e| FileError::io("定位原 Markdown", path, e))?;
            document.parent().ok_or_else(|| invalid("原 Markdown 目录无效"))?.to_path_buf()
        }
        None => draft_root(data_dir, session_id),
    };
    if !source_root.exists() { return Ok((Vec::new(), Vec::new(), Vec::new(), urls.iter().filter(|url| !is_remote_reference(url)).cloned().collect())); }
    let source_base = fs::canonicalize(&source_root).map_err(|e| FileError::io("定位原资源目录", &source_root, e))?;
    let target_name = target_document.file_stem().and_then(|value| value.to_str()).unwrap_or("untitled");
    let target_parts = directory_parts(template, target_name)?;
    let target_parent = target_document.parent().ok_or_else(|| invalid("目标 Markdown 目录无效"))?;
    let target_root = fs::canonicalize(target_parent).map_err(|e| FileError::io("定位目标 Markdown 目录", target_parent, e))?;
    let source_assets = source_base.join(old_parts.join("/"));
    let mut copied = Vec::new();
    let mut created = Vec::new();
    let mut draft_originals = Vec::new();
    let mut unresolved = Vec::new();
    let mut mapped_files: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let result = (|| -> Result<(), FileError> {
        // Snapshot the source tree before creating target files. This also handles
        // a shared directory template such as "assets" in the same parent folder.
        if source_document.is_some() && source_assets.is_dir() {
            let canonical_assets = fs::canonicalize(&source_assets).map_err(|e| FileError::io("定位原资源目录", &source_assets, e))?;
            if !canonical_assets.starts_with(&source_base) { return Err(invalid("原资源目录越出 Markdown 目录")); }
            let mut files = Vec::new();
            collect_directory_files(&source_assets, Path::new(""), &mut files)?;
            for relative in files {
                let source = source_assets.join(&relative);
                let mut folder = target_parts.clone();
                if let Some(parent) = relative.parent() {
                    for component in parent.components() { folder.push(component.as_os_str().to_string_lossy().into_owned()); }
                }
                let (target, parts) = copy_unique(&target_root, &folder, &source)?;
                created.push(target);
                mapped_files.insert(fs::canonicalize(&source).map_err(|e| FileError::io("定位原资源", &source, e))?, parts);
            }
        }
        for url in urls {
            if is_remote_reference(url) { continue; }
            let old_path = if source_document.is_none() {
                let decoded = match urlencoding::decode(url) { Ok(value) => value, Err(_) => { unresolved.push(url.clone()); continue; } };
                let components: Vec<&str> = decoded.split('/').collect();
                match draft_image(&source_base, &components)? { Some(path) => path, None => { unresolved.push(url.clone()); continue; } }
            } else {
                match local_image(&source_base, &source_assets, style, url)? { Some(path) => path, None => { unresolved.push(url.clone()); continue; } }
            };
            let parts = if let Some(parts) = mapped_files.get(&old_path) { parts.clone() } else {
                let (target, parts) = copy_unique(&target_root, &target_parts, &old_path)?;
                created.push(target);
                mapped_files.insert(old_path.clone(), parts.clone());
                parts
            };
            let new_url = url_from_parts(&parts, style, &target_parts);
            copied.push(CopiedReference { old_url: url.clone(), new_url });
            if source_document.is_none() { draft_originals.push(old_path); }
        }
        Ok(())
    })();
    if let Err(error) = result { for path in created { let _ = fs::remove_file(path); } return Err(error); }
    Ok((copied, created, draft_originals, unresolved))
}

pub struct PreparedMove {
    pub references: Vec<CopiedReference>,
    pub created: Vec<PathBuf>,
    pub planned_targets: Vec<PathBuf>,
    pub resource_operations: Vec<MoveResourceOperation>,
    pub old_assets: Option<PathBuf>,
    pub unresolved: Vec<String>,
    source_manifest: Vec<(PathBuf, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResourceOperation { pub source: String, pub target: String, pub action: &'static str }

pub fn cleanup_old_assets(prepared: &PreparedMove) -> Option<String> {
    let folder = prepared.old_assets.as_ref()?;
    let check = (|| -> Result<(), FileError> {
        let mut current = Vec::new();
        collect_directory_files(folder, Path::new(""), &mut current)?;
        current.sort();
        let mut expected = prepared.source_manifest.iter().map(|(relative, _)| relative.clone()).collect::<Vec<_>>();
        expected.sort();
        if current != expected { return Err(invalid("原资源目录内容在迁移期间变化")); }
        for (relative, hash) in &prepared.source_manifest {
            if file_hash(&folder.join(relative))? != *hash { return Err(invalid("原资源文件在迁移期间变化")); }
        }
        fs::remove_dir_all(folder).map_err(|e| FileError::io("移除原资源目录", folder, e))
    })();
    check.err().map(|error| format!("原资源目录保留：{}", error.message))
}

pub fn prepare_move(source_document: &Path, target_document: &Path, template: &str, style: &str,
    urls: &[String]) -> Result<PreparedMove, FileError> {
    prepare_move_inner(source_document, target_document, template, style, urls, false)
}

pub fn preview_move(source_document: &Path, target_document: &Path, template: &str, style: &str,
    urls: &[String]) -> Result<PreparedMove, FileError> {
    prepare_move_inner(source_document, target_document, template, style, urls, true)
}

fn move_copy(root: &Path, directory: &[String], original: &Path, preview: bool,
    reserved: &mut HashSet<PathBuf>) -> Result<(PathBuf, Vec<String>), FileError> {
    if !preview { return copy_unique(root, directory, original); }
    let mut folder = root.to_path_buf();
    for part in directory {
        folder.push(part);
        if folder.exists() {
            let resolved = fs::canonicalize(&folder).map_err(|e| FileError::io("检查目标资源目录", &folder, e))?;
            if !resolved.starts_with(root) || !resolved.is_dir() { return Err(invalid("目标资源目录越界或不是目录")); }
        }
    }
    let name = original.file_name().and_then(|value| value.to_str()).ok_or_else(|| invalid("图片文件名无效"))?;
    if !safe_segment(name) { return Err(invalid("图片文件名无效")); }
    let stem = Path::new(name).file_stem().and_then(|value| value.to_str()).unwrap_or("image");
    let ext = Path::new(name).extension().and_then(|value| value.to_str());
    for number in 1..=9999 {
        let candidate = if number == 1 { name.to_owned() } else if let Some(ext) = ext {
            format!("{stem}-{number}.{ext}")
        } else { format!("{stem}-{number}") };
        let target = folder.join(&candidate);
        if target.exists() || reserved.contains(&target) { continue; }
        reserved.insert(target.clone());
        let mut parts = directory.to_vec();
        parts.push(candidate);
        return Ok((target, parts));
    }
    Err(invalid("图片资源同名冲突过多"))
}

fn prepare_move_inner(source_document: &Path, target_document: &Path, template: &str, style: &str,
    urls: &[String], preview: bool) -> Result<PreparedMove, FileError> {
    if !matches!(style, "relative" | "asset-relative") { return Err(invalid("图片引用格式无效")); }
    let source = fs::canonicalize(source_document).map_err(|e| FileError::io("定位原 Markdown", source_document, e))?;
    let source_root = source.parent().ok_or_else(|| invalid("原文档目录无效"))?;
    let target_parent = target_document.parent().ok_or_else(|| invalid("目标文档目录无效"))?;
    let target_root = fs::canonicalize(target_parent).map_err(|e| FileError::io("定位目标目录", target_parent, e))?;
    let old_name = source.file_stem().and_then(|name| name.to_str()).ok_or_else(|| invalid("原文档名无效"))?;
    let new_name = target_document.file_stem().and_then(|name| name.to_str()).ok_or_else(|| invalid("目标文档名无效"))?;
    let old_parts = directory_parts(template, old_name)?;
    let new_parts = directory_parts(template, new_name)?;
    let old_assets = source_root.join(old_parts.join("/"));
    let new_assets = target_root.join(new_parts.join("/"));
    let dedicated = template.contains("${filename}") && old_assets != new_assets;
    let mut prepared = PreparedMove { references: Vec::new(), created: Vec::new(), planned_targets: Vec::new(),
        resource_operations: Vec::new(), old_assets: None, unresolved: Vec::new(), source_manifest: Vec::new() };
    let mut mapped: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let mut reserved = HashSet::new();
    let result = (|| -> Result<(), FileError> {
        if dedicated && old_assets.is_dir() {
            let canonical_assets = fs::canonicalize(&old_assets).map_err(|e| FileError::io("定位原资源目录", &old_assets, e))?;
            if !canonical_assets.starts_with(source_root) { return Err(invalid("资源目录越出原 Markdown 目录")); }
            let mut files = Vec::new();
            collect_directory_files(&old_assets, Path::new(""), &mut files)?;
            files.sort();
            for relative in files {
                let original = old_assets.join(&relative);
                prepared.source_manifest.push((relative.clone(), file_hash(&original)?));
                let mut folder = new_parts.clone();
                if let Some(parent) = relative.parent() {
                    for part in parent.components() { folder.push(part.as_os_str().to_string_lossy().into_owned()); }
                }
                let (target, parts) = move_copy(&target_root, &folder, &original, preview, &mut reserved)?;
                prepared.planned_targets.push(target.clone());
                prepared.resource_operations.push(MoveResourceOperation { source: original.to_string_lossy().into_owned(),
                    target: target.to_string_lossy().into_owned(), action: "move" });
                if !preview { prepared.created.push(target); }
                mapped.insert(fs::canonicalize(&original).map_err(|e| FileError::io("定位原图片", &original, e))?, parts);
            }
            prepared.old_assets = Some(old_assets.clone());
        }
        for url in urls {
            if is_remote_reference(url) { continue; }
            let original = match local_image(source_root, &old_assets, style, url)? {
                Some(path) => path,
                None => { prepared.unresolved.push(url.clone()); continue; }
            };
            let new_url = if let Some(parts) = mapped.get(&original) {
                url_from_parts(parts, style, &new_parts)
            } else if original.starts_with(&old_assets) && old_assets == new_assets {
                url.clone()
            } else if original.starts_with(&old_assets) {
                let (target, parts) = move_copy(&target_root, &new_parts, &original, preview, &mut reserved)?;
                prepared.planned_targets.push(target.clone());
                prepared.resource_operations.push(MoveResourceOperation { source: original.to_string_lossy().into_owned(),
                    target: target.to_string_lossy().into_owned(), action: if dedicated { "move" } else { "copy" } });
                if !preview { prepared.created.push(target); }
                mapped.insert(original.clone(), parts.clone());
                url_from_parts(&parts, style, &new_parts)
            } else {
                // A readable image outside this document's managed directory belongs to
                // its original owner, even when it happens to be on the same volume.
                let (target, parts) = move_copy(&target_root, &new_parts, &original, preview, &mut reserved)?;
                prepared.planned_targets.push(target.clone());
                prepared.resource_operations.push(MoveResourceOperation { source: original.to_string_lossy().into_owned(),
                    target: target.to_string_lossy().into_owned(), action: "copy" });
                if !preview { prepared.created.push(target); }
                mapped.insert(original.clone(), parts.clone());
                url_from_parts(&parts, style, &new_parts)
            };
            prepared.references.push(CopiedReference { old_url: url.clone(), new_url });
        }
        Ok(())
    })();
    if let Err(error) = result {
        for path in prepared.created { let _ = fs::remove_file(path); }
        return Err(error);
    }
    Ok(prepared)
}

pub fn plan_selected_relinks(document_path: &Path, template: &str, style: &str,
    selected: &[(String, String)]) -> Result<RelinkArchivePlan, FileError> {
    if !matches!(style, "relative" | "asset-relative") { return Err(invalid("图片引用格式无效")); }
    let document = fs::canonicalize(document_path).map_err(|e| FileError::io("定位文档", document_path, e))?;
    let root = document.parent().ok_or_else(|| invalid("文档目录无效"))?;
    let filename = document.file_stem().and_then(|name| name.to_str()).ok_or_else(|| invalid("文档名无效"))?;
    let parts = directory_parts(template, filename)?;
    let target_directory = root.join(parts.join("/"));
    let mut references = Vec::new();
    let mut copies = Vec::new();
    let mut selected_sources: HashMap<PathBuf, String> = HashMap::new();
    let mut reserved = HashSet::new();
    for (old_url, source_path) in selected {
            let original = fs::canonicalize(source_path).map_err(|e| FileError::io("定位选中图片", Path::new(source_path), e))?;
            let metadata = original.metadata().map_err(|e| FileError::io("检查选中图片", &original, e))?;
            if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 { return Err(invalid("选中图片无效或超过 20 MB")); }
            let mut file = fs::File::open(&original).map_err(|e| FileError::io("读取选中图片", &original, e))?;
            let mut signature = [0u8; 12];
            let count = file.read(&mut signature).map_err(|e| FileError::io("读取图片类型", &original, e))?;
            if raster_extension(&signature[..count]).is_none() { return Err(invalid("仅能归档 PNG、JPEG、GIF、WebP 图片")); }
            if let Some(new_url) = selected_sources.get(&original) {
                references.push(CopiedReference { old_url: old_url.clone(), new_url: new_url.clone() });
                continue;
            }
            let source_name = original.file_name().and_then(|name| name.to_str()).ok_or_else(|| invalid("图片文件名无效"))?;
            if !safe_segment(source_name) { return Err(invalid("图片文件名无效")); }
            let stem = original.file_stem().and_then(|name| name.to_str()).unwrap_or("image");
            let extension = original.extension().and_then(|name| name.to_str());
            let mut chosen = None;
            for number in 1..=9999 {
                let name = if number == 1 { source_name.to_owned() } else if let Some(ext) = extension {
                    format!("{stem}-{number}.{ext}")
                } else { format!("{stem}-{number}") };
                let target = target_directory.join(&name);
                let key = target.to_string_lossy().to_lowercase();
                if reserved.contains(&key) { continue; }
                if target.exists() {
                    if !target.is_file() { return Err(invalid("目标图片路径不是文件")); }
                    if file_hash(&original)? != file_hash(&target)? { continue; }
                    chosen = Some((name, target, true));
                } else { chosen = Some((name, target, false)); }
                break;
            }
            let (name, target, reused) = chosen.ok_or_else(|| invalid("图片资源同名冲突过多"))?;
            reserved.insert(target.to_string_lossy().to_lowercase());
            let mut ref_parts = parts.clone();
            ref_parts.push(name);
            let new_url = url_from_parts(&ref_parts, style, &parts);
            selected_sources.insert(original.clone(), new_url.clone());
            references.push(CopiedReference { old_url: old_url.clone(), new_url });
            copies.push(RelinkCopy { source: original.to_string_lossy().into_owned(),
                target: target.to_string_lossy().into_owned(), reused });
    }
    Ok(RelinkArchivePlan { target_directory: target_directory.to_string_lossy().into_owned(), references, copies })
}

pub fn archive_selected_relinks(document_path: &Path, template: &str, style: &str,
    selected: &[(String, String)]) -> Result<(Vec<CopiedReference>, Vec<PathBuf>), FileError> {
    let plan = plan_selected_relinks(document_path, template, style, selected)?;
    execute_relink_archive_plan(document_path, template, plan)
}

fn execute_relink_archive_plan(document_path: &Path, template: &str, plan: RelinkArchivePlan)
    -> Result<(Vec<CopiedReference>, Vec<PathBuf>), FileError> {
    let document = fs::canonicalize(document_path).map_err(|e| FileError::io("定位文档", document_path, e))?;
    let root = document.parent().ok_or_else(|| invalid("文档目录无效"))?;
    let name = document.file_stem().and_then(|name| name.to_str()).ok_or_else(|| invalid("文档名无效"))?;
    let parts = directory_parts(template, name)?;
    let target_dir = checked_directory(root, &parts)?;
    let mut created = Vec::new();
    let result = (|| -> Result<(), FileError> {
        for copy in &plan.copies {
            let target = Path::new(&copy.target);
            if !target.starts_with(&target_dir) { return Err(invalid("图片目标目录已变化")); }
            if copy.reused {
                if file_hash(Path::new(&copy.source))? != file_hash(target)? {
                    return Err(invalid("目标图片内容已变化，请重新预览"));
                }
                continue;
            }
            let mut output = OpenOptions::new().write(true).create_new(true).open(target)
                .map_err(|e| FileError::io("创建图片资源", target, e))?;
            created.push(target.to_path_buf());
            let mut input = fs::File::open(&copy.source).map_err(|e| FileError::io("读取选中图片", Path::new(&copy.source), e))?;
            io::copy(&mut input, &mut output).map_err(|e| FileError::io("复制图片资源", target, e))?;
            output.sync_all().map_err(|e| FileError::io("同步图片资源", target, e))?;
            if file_hash(Path::new(&copy.source))? != file_hash(target)? { return Err(invalid("图片复制后校验失败")); }
        }
        Ok(())
    })();
    if let Err(error) = result { for path in created { let _ = fs::remove_file(path); } return Err(error); }
    Ok((plan.references, created))
}

pub fn read_draft(data_dir: &Path, session_id: &str, image_path: &str) -> Result<Vec<u8>, FileError> {
    let root = draft_root(data_dir, session_id);
    let base = fs::canonicalize(&root).map_err(|e| FileError::io("定位临时图片目录", &root, e))?;
    if image_path.split(['/', '\\']).any(|part| !safe_segment(part)) { return Err(invalid("图片路径无效")); }
    let path = fs::canonicalize(base.join(image_path)).map_err(|e| FileError::io("定位临时图片", &base, e))?;
    if !path.starts_with(base) || !path.is_file() { return Err(invalid("临时图片路径越界")); }
    fs::read(&path).map_err(|e| FileError::io("读取临时图片", &path, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_custom_paths_conflicts_and_draft_copy() {
        let root = std::env::temp_dir().join(format!("mintdown-assets-{}-{}", std::process::id(), crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        let document = root.join("文章.md");
        fs::write(&document, "# 正文").unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        for (template, style, expected) in [
            ("${filename}", "relative", "![](%E6%96%87%E7%AB%A0/image.png)"),
            ("${filename}.assets", "relative", "![](%E6%96%87%E7%AB%A0.assets/image.png)"),
            ("images/${filename}", "relative", "![](images/%E6%96%87%E7%AB%A0/image.png)"),
            ("assets", "asset-relative", "![](image.png)"),
        ] {
            let result = archive(&root, Some(&document), "one", template, style, "image.png", png).unwrap();
            assert_eq!(result.reference, expected);
            let folder = root.join(directory_parts(template, "文章").unwrap().join("/"));
            assert_eq!(fs::read(folder.join("image.png")).unwrap(), png);
            let second = archive(&root, Some(&document), "one", template, style, "image.png", png).unwrap();
            assert_eq!(second.name, "image-2.png");
            assert_eq!(fs::read(folder.join("image.png")).unwrap(), png);
        }
        for template in ["../escape", "C:/escape", "/absolute", "assets//nested", "aux", "images/${other}"] {
            assert!(directory_parts(template, "文章").is_err(), "{template}");
        }
        let draft = archive(&root, None, "draft", "${filename}.assets", "relative", "image.png", png).unwrap();
        assert_eq!(draft.reference, "![](untitled.assets/image.png)");
        assert_eq!(read_draft(&root, "draft", "untitled.assets/image.png").unwrap(), png);
        let target = root.join("新文章.md");
        let (mapped, created, originals, unresolved) = copy_referenced(&root, None, "draft", &target, "${filename}.assets", "relative", &["untitled.assets/image.png".into()]).unwrap();
        assert_eq!(mapped[0].new_url, "%E6%96%B0%E6%96%87%E7%AB%A0.assets/image.png");
        assert_eq!(fs::read(&created[0]).unwrap(), png);
        assert_eq!(originals.len(), 1);
        assert!(unresolved.is_empty());
        let changed = root.join("changed.md");
        let (changed_refs, changed_files, _, _) = copy_referenced(&root, None, "draft", &changed,
            "images/${filename}", "relative", &["untitled.assets/image.png".into()]).unwrap();
        assert_eq!(changed_refs[0].new_url, "images/changed/image.png");
        assert_eq!(fs::read(&changed_files[0]).unwrap(), png);
        let short = archive(&root, None, "short-draft", "assets", "asset-relative", "short.png", png).unwrap();
        assert_eq!(short.reference, "![](short.png)");
        let (short_refs, short_files, _, _) = copy_referenced(&root, None, "short-draft", &changed,
            "${filename}.assets", "relative", &["short.png".into()]).unwrap();
        assert_eq!(short_refs[0].new_url, "changed.assets/short.png");
        assert_eq!(fs::read(&short_files[0]).unwrap(), png);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_as_copies_historical_directory_and_external_images_across_folders() {
        let root = std::env::temp_dir().join(format!("mintdown-copy-{}-{}", std::process::id(), crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        let source = source_dir.join("old.md");
        let target = target_dir.join("new.md");
        let source_text = "![x](images/old/image.png)\n![external](other/image.png)\n![missing](missing.png)\n![](https://example.invalid/image.png)\n";
        fs::write(&source, source_text).unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        fs::create_dir_all(source_dir.join("images/old")).unwrap();
        fs::create_dir_all(source_dir.join("other")).unwrap();
        fs::create_dir_all(target_dir.join("images/new")).unwrap();
        fs::write(source_dir.join("images/old/image.png"), png).unwrap();
        fs::write(source_dir.join("images/old/note.txt"), "保留附件").unwrap();
        fs::write(source_dir.join("other/image.png"), png).unwrap();
        fs::write(target_dir.join("images/new/image.png"), b"existing").unwrap();
        let urls = ["images/old/image.png".into(), "other/image.png".into(), "missing.png".into(), "https://example.invalid/image.png".into()];
        let (mapped, created, draft, unresolved) = copy_referenced(&root, Some(&source), "source", &target,
            "images/${filename}", "relative", &urls).unwrap();
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].old_url, "images/old/image.png");
        assert_eq!(mapped[0].new_url, "images/new/image-2.png");
        assert_eq!(mapped[1].new_url, "images/new/image-3.png");
        assert_eq!(created.len(), 3);
        assert!(draft.is_empty());
        assert_eq!(unresolved, vec!["missing.png"]);
        assert_eq!(fs::read(target_dir.join("images/new/image.png")).unwrap(), b"existing");
        assert_eq!(fs::read(target_dir.join("images/new/image-2.png")).unwrap(), png);
        assert_eq!(fs::read(target_dir.join("images/new/image-3.png")).unwrap(), png);
        assert_eq!(fs::read_to_string(target_dir.join("images/new/note.txt")).unwrap(), "保留附件");
        assert_eq!(fs::read(source_dir.join("images/old/image.png")).unwrap(), png);
        assert_eq!(fs::read_to_string(&source).unwrap(), source_text);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_as_uses_one_copy_flow_for_presets_and_custom_templates() {
        let root = std::env::temp_dir().join(format!("mintdown-template-copy-{}-{}", std::process::id(), crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        for (index, (template, style, original_url, expected_url)) in [
            ("${filename}", "relative", "old/picture.png", "new/picture.png"),
            ("${filename}.assets", "relative", "old.assets/picture.png", "new.assets/picture.png"),
            ("pictures/${filename}", "relative", "pictures/old/picture.png", "pictures/new/picture.png"),
            ("assets", "asset-relative", "picture.png", "picture.png"),
        ].into_iter().enumerate() {
            let source_folder = root.join(format!("source-{index}"));
            let target_folder = root.join(format!("target-{index}"));
            fs::create_dir_all(&source_folder).unwrap();
            fs::create_dir_all(&target_folder).unwrap();
            let source = source_folder.join("old.md");
            let target = target_folder.join("new.md");
            fs::write(&source, format!("![图]({original_url})")).unwrap();
            let old_assets = source_folder.join(directory_parts(template, "old").unwrap().join("/"));
            fs::create_dir_all(&old_assets).unwrap();
            fs::write(old_assets.join("picture.png"), b"historical picture").unwrap();
            let (mapped, created, _, unresolved) = copy_referenced(&root, Some(&source), "x", &target,
                template, style, &[original_url.into()]).unwrap();
            assert!(unresolved.is_empty(), "{template}");
            assert_eq!(mapped.len(), 1, "{template}");
            assert_eq!(mapped[0].new_url, expected_url, "{template}");
            assert_eq!(created.len(), 1, "{template}");
            assert_eq!(fs::read(&created[0]).unwrap(), b"historical picture", "{template}");
            assert_eq!(fs::read(old_assets.join("picture.png")).unwrap(), b"historical picture");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_dedicated_assets_and_keep_external_files() {
        let root = std::env::temp_dir().join(format!("mintdown-move-{}-{}", std::process::id(), crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(source_dir.join("old.assets")).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(source_dir.join("old.md"), "![a](old.assets/a.png) ![b](outside.png)").unwrap();
        fs::write(source_dir.join("old.assets/a.png"), b"image").unwrap();
        fs::write(source_dir.join("old.assets/unreferenced.png"), b"keep").unwrap();
        fs::write(source_dir.join("outside.png"), b"external").unwrap();
        let plan = prepare_move(&source_dir.join("old.md"), &target_dir.join("new.md"), "${filename}.assets", "relative",
            &["old.assets/a.png".into(), "outside.png".into()]).unwrap();
        assert_eq!(plan.references[0].new_url, "new.assets/a.png");
        assert_eq!(plan.references[1].new_url, "new.assets/outside.png");
        assert_eq!(fs::read(target_dir.join("new.assets/outside.png")).unwrap(), b"external");
        assert_eq!(fs::read(target_dir.join("new.assets/unreferenced.png")).unwrap(), b"keep");
        assert_eq!(fs::read(source_dir.join("old.assets/a.png")).unwrap(), b"image");
        assert_eq!(fs::read(source_dir.join("outside.png")).unwrap(), b"external");
        fs::write(source_dir.join("old.assets/new-during-move.png"), b"new user data").unwrap();
        assert!(cleanup_old_assets(&plan).is_some());
        assert!(source_dir.join("old.assets/new-during-move.png").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_preview_is_read_only_and_matches_apply_plan() {
        let root = std::env::temp_dir().join(format!("mintdown-move-preview-{}-{}", std::process::id(),
            crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(root.join("from/old.assets")).unwrap();
        fs::create_dir_all(root.join("to/new.assets")).unwrap();
        fs::write(root.join("from/old.md"), "![ok](old.assets/a.png) ![missing](gone.png)").unwrap();
        fs::write(root.join("from/old.assets/a.png"), b"source").unwrap();
        fs::write(root.join("to/new.assets/a.png"), b"existing").unwrap();
        let urls = ["old.assets/a.png".into(), "gone.png".into()];
        let target = root.join("to/new.md");
        let preview = preview_move(&root.join("from/old.md"), &target, "${filename}.assets", "relative", &urls).unwrap();
        assert!(preview.created.is_empty());
        assert_eq!(preview.planned_targets.len(), 1);
        assert!(!root.join("to/new.assets/a-2.png").exists());
        assert!(!target.exists());
        assert_eq!(preview.unresolved, vec!["gone.png"]);
        let actual = prepare_move(&root.join("from/old.md"), &target, "${filename}.assets", "relative", &urls).unwrap();
        assert_eq!(preview.references, actual.references);
        assert_eq!(preview.planned_targets, actual.planned_targets);
        assert_eq!(preview.unresolved, actual.unresolved);
        assert!(root.join("to/new.assets/a-2.png").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_shared_directory_copies_only_referenced_assets() {
        let root = std::env::temp_dir().join(format!("mintdown-shared-move-{}-{}", std::process::id(), crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(root.join("a/assets")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/old.md"), "![x](assets/one.png)").unwrap();
        fs::write(root.join("a/assets/one.png"), b"one").unwrap();
        fs::write(root.join("a/assets/other.png"), b"other article").unwrap();
        let plan = prepare_move(&root.join("a/old.md"), &root.join("b/new.md"), "assets", "relative", &["assets/one.png".into()]).unwrap();
        assert_eq!(plan.references[0].new_url, "assets/one.png");
        assert_eq!(plan.created.len(), 1);
        assert!(plan.old_assets.is_none());
        assert!(!root.join("b/assets/other.png").exists());
        assert_eq!(fs::read(root.join("a/assets/other.png")).unwrap(), b"other article");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_archives_readable_external_image_once_and_keeps_its_owner() {
        let root = std::env::temp_dir().join(format!("mintdown-external-rename-{}-{}", std::process::id(),
            crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::create_dir_all(root.join("VSCode2test2.assets")).unwrap();
        let source = root.join("notes/VSCode2test4.md");
        let target = root.join("notes/VSCode2test5.md");
        let old_url = "../VSCode2test2.assets/image-20251201094811086.png";
        fs::write(&source, format!("![a]({old_url})\n![b]({old_url})")).unwrap();
        let external = root.join("VSCode2test2.assets/image-20251201094811086.png");
        fs::write(&external, b"readable image fixture").unwrap();
        for template in ["${filename}", "${filename}.assets", "images/${filename}"] {
            let preview = preview_move(&source, &target, template, "relative", &[old_url.into(), old_url.into()]).unwrap();
            assert_eq!(preview.resource_operations.len(), 1);
            assert_eq!(preview.resource_operations[0].action, "copy");
            let actual = prepare_move(&source, &target, template, "relative", &[old_url.into(), old_url.into()]).unwrap();
            assert_eq!(actual.references, preview.references);
            assert_eq!(actual.planned_targets, preview.planned_targets);
            assert_eq!(actual.created.len(), 1);
            let expected = format!("{}/image-20251201094811086.png", directory_parts(template, "VSCode2test5").unwrap().join("/"));
            assert_eq!(actual.references[0].new_url, expected);
            assert_eq!(actual.references[1].new_url, expected);
            assert_eq!(fs::read(&actual.created[0]).unwrap(), fs::read(&external).unwrap());
            for created in actual.created { fs::remove_file(created).unwrap(); }
        }
        assert!(source.exists());
        assert!(external.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_folder_rename_maps_presets_and_custom_managed_directories() {
        let root = std::env::temp_dir().join(format!("mintdown-rename-templates-{}-{}", std::process::id(),
            crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        for (index, (template, style, old_url, new_url)) in [
            ("${filename}", "relative", "VSCode2test3/image.png", "VSCode2test4/image.png"),
            ("${filename}.assets", "relative", "VSCode2test3.assets/image.png", "VSCode2test4.assets/image.png"),
            ("images/${filename}", "relative", "images/VSCode2test3/image.png", "images/VSCode2test4/image.png"),
            ("assets", "asset-relative", "image.png", "image.png"),
        ].into_iter().enumerate() {
            let folder = root.join(format!("case-{index}"));
            let old_assets = folder.join(directory_parts(template, "VSCode2test3").unwrap().join("/"));
            fs::create_dir_all(&old_assets).unwrap();
            let source = folder.join("VSCode2test3.md");
            let target = folder.join("VSCode2test4.md");
            fs::write(&source, format!("![图]({old_url})")).unwrap();
            fs::write(old_assets.join("image.png"), b"image").unwrap();
            let preview = preview_move(&source, &target, template, style, &[old_url.into()]).unwrap();
            assert_eq!(preview.references[0].new_url, new_url, "{template}");
            assert!(!target.exists(), "preview wrote target for {template}");
            let actual = prepare_move(&source, &target, template, style, &[old_url.into()]).unwrap();
            assert_eq!(actual.references, preview.references, "{template}");
            if template.contains("${filename}") {
                let new_assets = folder.join(directory_parts(template, "VSCode2test4").unwrap().join("/"));
                assert_eq!(fs::read(new_assets.join("image.png")).unwrap(), b"image", "{template}");
            } else {
                assert!(actual.created.is_empty(), "shared assets should not be copied on same-folder rename");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicitly_archived_relink_uses_unique_name_and_leaves_source() {
        let root = std::env::temp_dir().join(format!("mintdown-relink-archive-{}-{}", std::process::id(), crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(root.join("article.assets")).unwrap();
        fs::write(root.join("article.md"), "![x](missing.png)").unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        fs::write(root.join("selected.png"), png).unwrap();
        fs::write(root.join("article.assets/selected.png"), b"existing").unwrap();
        let (mapped, created) = archive_selected_relinks(&root.join("article.md"), "${filename}.assets", "relative",
            &[("missing.png".into(), root.join("selected.png").to_string_lossy().into_owned())]).unwrap();
        assert_eq!(mapped[0].new_url, "article.assets/selected-2.png");
        assert_eq!(fs::read(&created[0]).unwrap(), png);
        assert_eq!(fs::read(root.join("selected.png")).unwrap(), png);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_relink_plans_nine_copies_deduplicates_and_preserves_sources() {
        let root = std::env::temp_dir().join(format!("mintdown-batch-relink-{}-{}", std::process::id(),
            crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(root.join("old-images")).unwrap();
        let document = root.join("文章.md");
        fs::write(&document, "unchanged Markdown").unwrap();
        let mut selected = Vec::new();
        for index in 0..9 {
            let path = root.join(format!("old-images/image-{index}.png"));
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            bytes.push(index as u8);
            fs::write(&path, bytes).unwrap();
            selected.push((format!("missing-{index}.png"), path.to_string_lossy().into_owned()));
        }
        selected.push(("another-old-url.png".into(), selected[0].1.clone()));
        for (template, style, prefix) in [
            ("${filename}", "relative", "%E6%96%87%E7%AB%A0/"),
            ("${filename}.assets", "relative", "%E6%96%87%E7%AB%A0.assets/"),
            ("images/${filename}", "relative", "images/%E6%96%87%E7%AB%A0/"),
            ("assets", "asset-relative", ""),
        ] {
            let preview = plan_selected_relinks(&document, template, style, &selected).unwrap();
            assert_eq!(preview.copies.len(), 9, "{template}");
            assert_eq!(preview.references.len(), 10, "{template}");
            assert_eq!(preview.references[0].new_url, format!("{prefix}image-0.png"));
            assert_eq!(preview.references[9].new_url, preview.references[0].new_url);
            assert!(!Path::new(&preview.copies[0].target).exists(), "preview copied files");
            let (mapped, created) = archive_selected_relinks(&document, template, style, &selected).unwrap();
            assert_eq!(mapped, preview.references);
            assert_eq!(created.len(), 9);
            for (index, copy) in preview.copies.iter().enumerate() {
                assert_eq!(fs::read(&copy.source).unwrap(), fs::read(&copy.target).unwrap());
                assert!(copy.target.ends_with(&format!("image-{index}.png")));
            }
            let reused = plan_selected_relinks(&document, template, style, &selected).unwrap();
            assert!(reused.copies.iter().all(|copy| copy.reused));
            let (_, no_new_files) = archive_selected_relinks(&document, template, style, &selected).unwrap();
            assert!(no_new_files.is_empty());
        }
        assert_eq!(fs::read_to_string(&document).unwrap(), "unchanged Markdown");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_relink_rolls_back_new_files_when_later_copy_fails() {
        let root = std::env::temp_dir().join(format!("mintdown-relink-rollback-{}-{}", std::process::id(),
            crate::NEXT_ASSET_COPY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(root.join("source")).unwrap();
        let document = root.join("article.md");
        fs::write(&document, "![first](missing-1.png) ![second](missing-2.png)").unwrap();
        let image = b"\x89PNG\r\n\x1a\nfixture";
        let first = root.join("source/first.png");
        let second = root.join("source/second.png");
        fs::write(&first, image).unwrap();
        fs::write(&second, image).unwrap();
        let selected = [("missing-1.png".into(), first.to_string_lossy().into_owned()),
            ("missing-2.png".into(), second.to_string_lossy().into_owned())];
        let plan = plan_selected_relinks(&document, "${filename}.assets", "relative", &selected).unwrap();
        fs::remove_file(&second).unwrap();
        assert!(execute_relink_archive_plan(&document, "${filename}.assets", plan).is_err());
        assert!(!root.join("article.assets/first.png").exists());
        assert_eq!(fs::read_to_string(&document).unwrap(), "![first](missing-1.png) ![second](missing-2.png)");
        assert_eq!(fs::read(&first).unwrap(), image);
        fs::remove_dir_all(root).unwrap();
    }
}
