use crate::file_io::{self, FileError};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
type ExportMetrics = BTreeMap<String, f64>;
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder};

static NEXT_EXPORT: AtomicU64 = AtomicU64::new(1);

fn error(message: impl Into<String>) -> FileError {
    FileError {
        kind: "export",
        message: message.into(),
    }
}
fn check_target(path: &Path, extension: &str) -> Result<(), FileError> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        return Err(FileError {
            kind: "invalid_path",
            message: format!("导出目标必须是 .{extension} 绝对路径"),
        });
    }
    Ok(())
}
fn target_fingerprint(path: &Path) -> Result<Option<String>, FileError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(file_io::fingerprint(&bytes))),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(FileError::io("检查导出目标", path, cause)),
    }
}
fn save_output(
    path: &Path,
    extension: &str,
    bytes: &[u8],
    expected: Option<String>,
) -> Result<(), FileError> {
    check_target(path, extension)?;
    // The dialog confirmation is tied to this fingerprint. An intervening write
    // must not be silently overwritten, even after an expensive PDF render.
    file_io::save(path, expected.as_deref().unwrap_or(""), bytes, false)?;
    Ok(())
}

#[tauri::command]
pub fn export_target_fingerprint(
    path: String,
    extension: String,
) -> Result<Option<String>, FileError> {
    if !matches!(extension.as_str(), "html" | "pdf") {
        return Err(error("不支持的导出格式"));
    }
    check_target(Path::new(&path), &extension)?;
    target_fingerprint(Path::new(&path))
}

#[tauri::command]
pub async fn write_export_html(
    path: String,
    html: String,
    expected: Option<String>,
) -> Result<ExportMetrics, FileError> {
    let start = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        save_output(Path::new(&path), "html", html.as_bytes(), expected)
    })
    .await
    .map_err(|cause| error(cause.to_string()))??;
    Ok(BTreeMap::from([
        ("writeMs".into(), elapsed(start)),
        ("nativeTotalMs".into(), elapsed(start)),
    ]))
}

#[cfg(windows)]
async fn devtools(
    window: &tauri::WebviewWindow,
    method: &str,
    params: serde_json::Value,
    timeout: u64,
) -> Result<String, FileError> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::PCWSTR;
    let method = method.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let params = params
        .to_string()
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let callback = tx.clone();
            let result = (|| -> windows_core::Result<()> {
                let core = unsafe { webview.controller().CoreWebView2()? };
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        PCWSTR(method.as_ptr()),
                        PCWSTR(params.as_ptr()),
                        &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                            move |status, value| {
                                let _ = callback
                                    .send(status.map(|_| value).map_err(|cause| cause.to_string()));
                                Ok(())
                            },
                        )),
                    )
                }
            })();
            if let Err(cause) = result {
                let _ = tx.send(Err(cause.to_string()));
            }
        })
        .map_err(|cause| error(format!("无法访问打印 WebView：{cause}")))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(timeout)))
        .await
        .map_err(|cause| error(format!("打印任务失败：{cause}")))?
        .map_err(|cause| error(format!("打印操作超时：{cause}")))?
        .map_err(error)
}

#[cfg(windows)]
type LoadSignal = std::sync::Arc<Mutex<Option<(String, mpsc::Sender<()>)>>>;
#[cfg(windows)]
struct PrintView {
    window: tauri::WebviewWindow,
    loaded: LoadSignal,
    used: Instant,
}
#[cfg(windows)]
type PrintSlot = std::sync::Arc<tokio::sync::Mutex<Option<PrintView>>>;
#[cfg(windows)]
static PRINT_VIEWS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, PrintSlot>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn print_slot(owner: &tauri::WebviewWindow) -> PrintSlot {
    let views = PRINT_VIEWS.get_or_init(Default::default);
    let mut views = views.lock().unwrap();
    if let Some(slot) = views.get(owner.label()) {
        return slot.clone();
    }
    let slot = std::sync::Arc::new(tokio::sync::Mutex::new(None));
    views.insert(owner.label().into(), slot.clone());
    drop(views);
    let label = owner.label().to_owned();
    owner.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let slot = PRINT_VIEWS
                .get()
                .and_then(|views| views.lock().ok()?.remove(&label));
            if let Some(slot) = slot {
                tauri::async_runtime::spawn(async move {
                    if let Some(view) = slot.lock().await.take() {
                        let _ = view.window.destroy();
                    }
                });
            }
        }
    });
    slot
}

#[cfg(windows)]
fn retire_when_idle(slot: &PrintSlot, label: String) {
    let slot = std::sync::Arc::downgrade(slot);
    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(60);
        loop {
            tokio::time::sleep(delay).await;
            let Some(slot) = slot.upgrade() else {
                return;
            };
            let mut guard = slot.lock().await;
            let Some(view) = guard.as_ref() else {
                return;
            };
            if view.window.label() != label {
                return;
            }
            if view.used.elapsed() >= Duration::from_secs(60) {
                if let Some(view) = guard.take() {
                    let _ = view.window.destroy();
                }
                return;
            }
            delay = Duration::from_secs(60).saturating_sub(view.used.elapsed());
        }
    });
}

#[cfg(windows)]
async fn render_pdf(
    app: &AppHandle,
    owner: &tauri::WebviewWindow,
    html: &str,
    metrics: &mut ExportMetrics,
) -> Result<Vec<u8>, FileError> {
    use base64::Engine;
    use tauri::Manager;
    let queued = Instant::now();
    let slot = print_slot(owner);
    let mut guard = slot.lock().await;
    metrics.insert("queueMs".into(), elapsed(queued));
    if app.get_webview_window(owner.label()).is_none() {
        return Err(error("文档窗口已经关闭，导出已取消"));
    }
    let prepare = Instant::now();
    let root = crate::session_data(app)?.join("export-temp");
    std::fs::create_dir_all(&root)
        .map_err(|cause| FileError::io("创建打印临时目录", &root, cause))?;
    let id = format!(
        "{}-{}",
        std::process::id(),
        NEXT_EXPORT.fetch_add(1, Ordering::Relaxed)
    );
    let html_path = root.join(format!("{id}.html"));
    if let Err(cause) = std::fs::write(&html_path, html) {
        let _ = std::fs::remove_file(&html_path);
        return Err(FileError::io("准备打印 HTML", &html_path, cause));
    }
    metrics.insert("prepareMs".into(), elapsed(prepare));
    let result = async {
        let url = Url::from_file_path(&html_path).map_err(|_| error("无法定位打印 HTML"))?;
        let (tx, rx) = mpsc::channel();
        let create = Instant::now();
        let reused = guard.is_some();
        if let Some(view) = guard.as_ref() {
            *view.loaded.lock().unwrap() = Some((url.to_string(), tx));
            view.window.navigate(url).map_err(|cause| error(format!("加载打印页面失败：{cause}")))?;
        } else {
            let loaded: LoadSignal = std::sync::Arc::new(Mutex::new(Some((url.to_string(), tx))));
            let signal = loaded.clone();
            let window = WebviewWindowBuilder::new(app, format!("export-{id}"), WebviewUrl::External(url))
                .data_directory(crate::webview_data(app).map_err(error)?)
                .title("Mintdown PDF export").inner_size(1024.0, 768.0).visible(false).focused(false)
                .on_page_load(move |_window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        if let Ok(mut sender) = signal.lock() {
                            if sender.as_ref().is_some_and(|(url, _)| url == payload.url().as_str()) {
                                if let Some((_, tx)) = sender.take() { let _ = tx.send(()); }
                            }
                        }
                    }
                }).build().map_err(|cause| error(format!("创建独立打印 WebView 失败：{cause}")))?;
            retire_when_idle(&slot, window.label().into());
            *guard = Some(PrintView { window, loaded, used: Instant::now() });
        }
        metrics.insert("createMs".into(), elapsed(create));
        metrics.insert("reusedView".into(), if reused { 1.0 } else { 0.0 });
        let window = &guard.as_ref().unwrap().window;
        let load = Instant::now();
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(20)))
            .await.map_err(|cause| error(cause.to_string()))?.map_err(|cause| error(format!("打印页面加载超时：{cause}")))?;
        metrics.insert("loadMs".into(), elapsed(load));
        let resources = Instant::now();
        let ready = devtools(window, "Runtime.evaluate", serde_json::json!({"awaitPromise":true,"returnByValue":true,
            "expression":"Promise.all([document.fonts.ready,...Array.from(document.images,i=>i.decode())]).then(()=>{if(Array.from(document.fonts).some(f=>f.status==='error'))throw Error('打印字体加载失败');void document.body.offsetHeight;return true})"}), 15).await?;
        let ready: serde_json::Value = serde_json::from_str(&ready).map_err(|cause| error(cause.to_string()))?;
        if ready.get("exceptionDetails").is_some() { return Err(error(format!("PDF 图片或字体加载失败：{}", ready["exceptionDetails"]))); }
        metrics.insert("resourcesMs".into(), elapsed(resources));
        let print = Instant::now();
        let json = devtools(window, "Page.printToPDF", serde_json::json!({
            "paperWidth":8.27,"paperHeight":11.69,"marginTop":0.7,"marginBottom":0.7,"marginLeft":0.7,"marginRight":0.7,
            "printBackground":true,"displayHeaderFooter":false,"generateTaggedPDF":true,"generateDocumentOutline":true
        }),45).await?;
        metrics.insert("printMs".into(), elapsed(print));
        let validate = Instant::now();
        let needs_outline = (1..=6).any(|level| html.contains(&format!("<h{level}>")));
        let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, FileError> {
            let response: serde_json::Value = serde_json::from_str(&json).map_err(|cause| error(cause.to_string()))?;
            let data = response["data"].as_str().ok_or_else(|| error("WebView2 未返回 PDF 数据"))?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|cause| error(cause.to_string()))?;
            if bytes.len()<1000 || !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|part|part==b"%%EOF") { return Err(error("WebView2 生成的 PDF 不完整")); }
            if needs_outline && !bytes.windows(9).any(|part|part==b"/Outlines") { return Err(error("当前 WebView2 未生成 PDF 书签大纲，请更新 WebView2 运行时后重试")); }
            Ok(bytes)
        }).await.map_err(|cause|error(cause.to_string()))??;
        metrics.insert("validateMs".into(), elapsed(validate));
        Ok(bytes)
    }.await;
    let _ = std::fs::remove_file(&html_path);
    if result.is_err() {
        if let Some(view) = guard.take() {
            let _ = view.window.destroy();
        }
    } else if let Some(view) = guard.as_mut() {
        view.used = Instant::now();
    }
    result
}

#[tauri::command]
pub async fn read_export_image(
    app: AppHandle,
    document_path: Option<String>,
    session_id: String,
    image_path: String,
) -> Result<String, FileError> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        let image = if let Some(path) = document_path {
            crate::read_document_image(path, image_path)?
        } else {
            crate::read_draft_document_image(app, session_id, image_path)?
        };
        Ok(format!(
            "data:{};base64,{}",
            image.mime,
            base64::engine::general_purpose::STANDARD.encode(image.bytes)
        ))
    })
    .await
    .map_err(|cause| error(cause.to_string()))?
}

#[tauri::command]
pub async fn write_export_pdf(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    html: String,
    expected: Option<String>,
) -> Result<ExportMetrics, FileError> {
    let start = Instant::now();
    let target = PathBuf::from(&path);
    check_target(&target, "pdf")?;
    #[cfg(windows)]
    {
        let mut metrics = BTreeMap::new();
        let bytes = render_pdf(&app, &window, &html, &mut metrics).await?;
        let write = Instant::now();
        tauri::async_runtime::spawn_blocking(move || save_output(&target, "pdf", &bytes, expected))
            .await
            .map_err(|cause| error(cause.to_string()))??;
        metrics.insert("writeMs".into(), elapsed(write));
        metrics.insert("nativeTotalMs".into(), elapsed(start));
        Ok(metrics)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, html, expected);
        Err(error("PDF 导出目前需要 Windows WebView2"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_export_is_atomic_and_checks_target_fingerprint() {
        let path = std::env::temp_dir().join(format!(
            "mintdown-export-{}.html",
            NEXT_EXPORT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, b"original").unwrap();
        assert_eq!(
            save_output(&path, "html", b"new", None).unwrap_err().kind,
            "conflict"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        let expected = target_fingerprint(&path).unwrap();
        std::fs::write(&path, b"external").unwrap();
        assert_eq!(
            save_output(&path, "html", b"new", expected)
                .unwrap_err()
                .kind,
            "conflict"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
        let expected = target_fingerprint(&path).unwrap();
        save_output(&path, "html", b"new", expected).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        std::fs::remove_file(path).unwrap();
    }
}
