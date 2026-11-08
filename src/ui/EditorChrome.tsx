import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { clampFontSize, clampOutlineWidth, clampWritingWidth, outlineIndent, type EditorPreferences } from './preferences';
import type { OutlineHeading } from './outline';
import type { SearchOptions, SearchStatus } from './searchCommands';
import { revealOutlineItem } from './outlineScroll';
import { imageSettingsPreview } from '../assets/imagePaths';

export interface MenuAction {
  label: string;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  children?: MenuAction[];
}

export interface MenuGroup {
  label: string;
  actions: MenuAction[];
  extra?: ReactNode;
}

interface Props {
  fileName: string;
  documentPath?: string | null;
  dirty: boolean;
  mode: 'visual' | 'source';
  characterCount: number;
  outline: OutlineHeading[];
  activeHeading: number;
  onHeadingClick: (index: number) => void;
  preferences: EditorPreferences;
  onPreferencesChange: (next: EditorPreferences) => void;
  menus: MenuGroup[];
  searchMode: 'find' | 'replace' | null;
  onCloseSearch: () => void;
  searchOptions: SearchOptions;
  searchStatus: SearchStatus;
  onSearchOptionsChange: (next: SearchOptions) => void;
  onSearchAction: (action: 'next' | 'previous' | 'replace' | 'replaceAll') => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  onBatchRelink?: () => void;
  feedback?: ReactNode;
  children: ReactNode;
}

export function EditorChrome({ fileName, documentPath = null, dirty, mode, characterCount, outline, activeHeading,
  onHeadingClick, preferences, onPreferencesChange, menus, searchMode, onCloseSearch,
  searchOptions, searchStatus, onSearchOptionsChange, onSearchAction, settingsOpen, onCloseSettings,
  onBatchRelink, feedback, children }: Props) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openSubMenu, setOpenSubMenu] = useState<string | null>(null);
  const [settingsCategory, setSettingsCategory] = useState<'appearance' | 'editing' | 'images' | 'files'>('appearance');
  const [compact, setCompact] = useState(() => window.innerWidth < 760);
  const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const manualOutlineBrowsing = useRef(false);
  const showOutline = compact ? mobileOutlineOpen : preferences.outlineOpen;
  let imagePreview: ReturnType<typeof imageSettingsPreview> | null = null;
  let imageTemplateError = '';
  try { imagePreview = imageSettingsPreview(preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, documentPath ?? 'example.md'); }
  catch (error) { imageTemplateError = error instanceof Error ? error.message : String(error); }

  useEffect(() => {
    const onResize = () => { setCompact(window.innerWidth < 760); setMobileOutlineOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => { if (searchMode) searchRef.current?.focus(); }, [searchMode]);

  useEffect(() => {
    if (!showOutline || manualOutlineBrowsing.current || activeHeading < 0) return;
    const container = outlineRef.current;
    const item = container?.querySelector<HTMLElement>('[role="treeitem"][aria-current="location"]');
    if (container && item) revealOutlineItem(container, item);
  }, [activeHeading, outline, showOutline]);

  const resumeOutlineFollowing = () => {
    if (!manualOutlineBrowsing.current) return;
    manualOutlineBrowsing.current = false;
    const container = outlineRef.current;
    const item = container?.querySelector<HTMLElement>('[role="treeitem"][aria-current="location"]');
    if (container && item) revealOutlineItem(container, item);
  };

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);

  const toggleOutline = () => {
    if (compact) setMobileOutlineOpen((value) => !value);
    else onPreferencesChange({ ...preferences, outlineOpen: !preferences.outlineOpen });
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initialWidth = preferences.outlineWidth;
    const onMove = (next: PointerEvent) => onPreferencesChange({ ...preferences,
      outlineWidth: clampOutlineWidth(initialWidth + next.clientX - startX) });
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  const sizes = { '--outline-width': `${preferences.outlineWidth}px`, '--writing-width': `${preferences.writingWidth}px`, '--editor-font-size': `${preferences.fontSize}px` } as CSSProperties;
  return <main className="desktop-app" data-theme={preferences.theme} data-density={preferences.density} data-settings-open={settingsOpen} style={sizes}>
    <header className="app-menu-bar">
      <button className="outline-toggle" type="button" aria-label={showOutline ? '隐藏大纲' : '显示大纲'}
        aria-expanded={showOutline} onClick={toggleOutline}>☰</button>
      <nav ref={menuRef} className="menu-groups" aria-label="主菜单">
        {menus.map((group) => <div className="menu-group" key={group.label}>
          <button type="button" className="menu-trigger" aria-haspopup="menu" aria-expanded={openMenu === group.label}
            onClick={() => { setOpenSubMenu(null); setOpenMenu(openMenu === group.label ? null : group.label); }}>{group.label}</button>
          <div className="menu-popup" role="menu" hidden={openMenu !== group.label}>
            {group.actions.map((item) => <div className="menu-entry" key={item.label}
              onMouseEnter={() => setOpenSubMenu(item.children ? item.label : null)}>
              <button type="button" role="menuitem" disabled={item.disabled} aria-haspopup={item.children ? 'menu' : undefined}
                aria-expanded={item.children ? openSubMenu === item.label : undefined}
                onClick={() => { if (item.children) setOpenSubMenu(openSubMenu === item.label ? null : item.label);
                  else { setOpenMenu(null); item.onSelect?.(); } }}>{item.label}{item.children ? ' ▸' : ''}</button>
              {item.shortcut && <kbd aria-hidden="true">{item.shortcut}</kbd>}
              {item.children && <div className="menu-submenu" role="menu" aria-label={item.label} hidden={openSubMenu !== item.label}>
                {item.children.map((child) => <button key={child.label} type="button" role="menuitem" disabled={child.disabled}
                  onClick={() => { setOpenMenu(null); setOpenSubMenu(null); child.onSelect?.(); }}>{child.label}</button>)}
              </div>}
            </div>)}
            {group.extra && <div className="menu-extra">{group.extra}</div>}
          </div>
        </div>)}
      </nav>
      <div className="document-name" title={fileName}>{fileName}{dirty ? ' · 未保存' : ' · 已保存'}</div>
    </header>
    {feedback}
    {searchMode && <div className="search-panel" role="region" aria-label={searchMode === 'find' ? '查找面板' : '替换面板'}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); onCloseSearch(); }
        if (event.key === 'Enter') { event.preventDefault(); onSearchAction(event.shiftKey ? 'previous' : 'next'); }
      }}>
      <label>查找 <input ref={searchRef} aria-label="查找文本" value={searchOptions.text}
        onChange={(event) => onSearchOptionsChange({ ...searchOptions, text: event.target.value })} /></label>
      {searchMode === 'replace' && <label>替换 <input aria-label="替换文本" value={searchOptions.replace}
        onChange={(event) => onSearchOptionsChange({ ...searchOptions, replace: event.target.value })} /></label>}
      <label><input type="checkbox" aria-label="区分大小写" checked={searchOptions.caseSensitive}
        onChange={(event) => onSearchOptionsChange({ ...searchOptions, caseSensitive: event.target.checked })} />区分大小写</label>
      <label><input type="checkbox" aria-label="全词匹配" checked={searchOptions.wholeWord}
        onChange={(event) => onSearchOptionsChange({ ...searchOptions, wholeWord: event.target.checked })} />全词</label>
      {mode === 'source' && <label><input type="checkbox" aria-label="正则表达式" checked={searchOptions.regexp}
        onChange={(event) => onSearchOptionsChange({ ...searchOptions, regexp: event.target.checked })} />正则</label>}
      <span role="status">{!searchStatus.valid ? '正则表达式无效' : `${searchStatus.current}/${searchStatus.total}`}</span>
      <button type="button" onClick={() => onSearchAction('previous')} disabled={!searchStatus.total}>上一个</button>
      <button type="button" onClick={() => onSearchAction('next')} disabled={!searchStatus.total}>下一个</button>
      {searchMode === 'replace' && <>
        <button type="button" onClick={() => onSearchAction('replace')} disabled={!searchStatus.total}>替换当前</button>
        <button type="button" onClick={() => onSearchAction('replaceAll')} disabled={!searchStatus.total}>全部替换</button>
      </>}
      <button type="button" onClick={onCloseSearch} aria-label="关闭查找面板">×</button>
    </div>}
    {settingsOpen && <section className="settings-panel" role="tabpanel" aria-label="偏好设置">
      <div className="settings-heading"><strong>偏好设置</strong><button type="button" onClick={onCloseSettings} aria-label="关闭设置">×</button></div>
      <div className="settings-categories" role="tablist" aria-label="设置分类">
        <button type="button" role="tab" aria-selected={settingsCategory === 'appearance'} onClick={() => setSettingsCategory('appearance')}>外观</button>
        <button type="button" role="tab" aria-selected={settingsCategory === 'editing'} onClick={() => setSettingsCategory('editing')}>编辑</button>
        <button type="button" role="tab" aria-selected={settingsCategory === 'images'} onClick={() => setSettingsCategory('images')}>图片与附件</button>
        <button type="button" role="tab" aria-selected={settingsCategory === 'files'} onClick={() => setSettingsCategory('files')}>文件与会话</button>
      </div>
      {settingsCategory === 'appearance' && <div className="settings-content">
      <label>主题 <select aria-label="主题" value={preferences.theme}
        onChange={(event) => onPreferencesChange({ ...preferences, theme: event.target.value as 'light' | 'dark' })}>
        <option value="light">浅色</option><option value="dark">Tokyo Night Storm</option></select></label>
      <label>界面密度 <select aria-label="界面密度" value={preferences.density}
        onChange={(event) => onPreferencesChange({ ...preferences, density: event.target.value as 'standard' | 'compact' })}>
        <option value="standard">当前样式</option><option value="compact">紧凑实验样式</option></select></label>
      <label>正文字号 <input aria-label="设置正文字号" type="range" min="14" max="26" value={preferences.fontSize}
        onChange={(event) => onPreferencesChange({ ...preferences, fontSize: clampFontSize(Number(event.target.value)) })} />{preferences.fontSize}px</label>
      <label>正文最大宽度 <input aria-label="设置正文宽度" type="range" min="600" max="1200" step="20" value={preferences.writingWidth}
        onChange={(event) => onPreferencesChange({ ...preferences, writingWidth: clampWritingWidth(Number(event.target.value)) })} />{preferences.writingWidth}px</label>
      <label><input type="checkbox" aria-label="默认显示大纲" checked={preferences.outlineOpen}
        onChange={(event) => onPreferencesChange({ ...preferences, outlineOpen: event.target.checked })} />默认显示大纲</label>
      <label>大纲宽度 <input aria-label="设置大纲宽度" type="range" min="200" max="420" step="10" value={preferences.outlineWidth}
        onChange={(event) => onPreferencesChange({ ...preferences, outlineWidth: clampOutlineWidth(Number(event.target.value)) })} />{preferences.outlineWidth}px</label>
      </div>}
      {settingsCategory === 'editing' && <div className="settings-content"><label><input type="checkbox" aria-label="拼写检查" checked={preferences.spellCheck}
        onChange={(event) => onPreferencesChange({ ...preferences, spellCheck: event.target.checked })} />英文拼写检查</label>
      </div>}
      {settingsCategory === 'files' && <div className="settings-content"><label><input type="checkbox" aria-label="启动时恢复上次会话" checked={preferences.restoreLastSession}
        onChange={(event) => onPreferencesChange({ ...preferences, restoreLastSession: event.target.checked })} />启动时恢复上次会话</label>
      </div>}
      {settingsCategory === 'images' &&
      <div className="settings-content image-settings"><h3>资源目录与引用</h3>
        <label>资源目录 <select aria-label="资源目录预设" value={['${filename}', '${filename}.assets'].includes(preferences.imageDirectoryTemplate) ? preferences.imageDirectoryTemplate : 'custom'}
          onChange={(event) => onPreferencesChange({ ...preferences, imageDirectoryTemplate: event.target.value === 'custom' ? 'images/${filename}' : event.target.value })}>
          <option value={'${filename}'}>同名目录</option><option value={'${filename}.assets'}>.assets 目录</option><option value="custom">自定义</option></select></label>
        <input aria-label="资源目录模板" value={preferences.imageDirectoryTemplate}
          onChange={(event) => onPreferencesChange({ ...preferences, imageDirectoryTemplate: event.target.value })} />
        <label>引用格式 <select aria-label="图片引用格式" value={preferences.imageReferenceStyle}
          onChange={(event) => onPreferencesChange({ ...preferences, imageReferenceStyle: event.target.value as EditorPreferences['imageReferenceStyle'] })}>
          <option value="relative">标准文件相对路径</option><option value="asset-relative">资源目录内相对引用</option></select></label>
        {preferences.imageReferenceStyle === 'asset-relative' && <small>仅适用于已配置文章资源路径解析的博客；普通 Markdown 查看器可能无法找到图片。</small>}
        {imageTemplateError ? <small role="alert">{imageTemplateError}</small> : <small>以 {documentPath ? documentPath.split(/[\\/]/).pop() : 'example.md'} 为例：<br />文件夹：{imagePreview?.folder}<br />引用：<code>{imagePreview?.markdown}</code></small>}
        <small>修改设置只影响之后插入的图片，不自动迁移已有文章资源。</small>
        <div className="settings-section-divider" />
        <h3>当前文档工具</h3>
        <p>作用文档：<strong>{fileName}</strong></p>
        <button type="button" onClick={onBatchRelink} disabled={!documentPath}>重新定位当前文档的缺失图片…</button>
        {!documentPath && <small>请先保存当前文档，再批量重新定位。</small>}
      </div>}
    </section>}
    <div className={`workspace${compact ? ' compact' : ''}`}>
      {showOutline && <>
        <aside ref={outlineRef} className="outline-sidebar" aria-label="文档大纲"
          onWheelCapture={() => { manualOutlineBrowsing.current = true; }}
          onPointerDownCapture={() => { manualOutlineBrowsing.current = true; }}>
          <div className="outline-heading"><span>大纲</span><small>{outline.length} 个标题</small></div>
          {outline.length ? <ol className="outline-list" role="tree">
            {outline.map((heading, index) => <li key={`${index}-${heading.position}`} role="none">
              <button type="button" role="treeitem" aria-level={heading.level} aria-current={activeHeading === index ? 'location' : undefined}
                className={activeHeading === index ? 'active' : ''}
                style={{ paddingLeft: `${outlineIndent(heading.level, preferences.density)}px` }}
                title={heading.text} onClick={() => { manualOutlineBrowsing.current = false; onHeadingClick(index); setMobileOutlineOpen(false); }}>
                {heading.text}
              </button>
            </li>)}
          </ol> : <p className="outline-empty">暂无标题</p>}
        </aside>
        {!compact && <div className="outline-resizer" role="separator" aria-label="调整大纲宽度"
          aria-orientation="vertical" aria-valuenow={preferences.outlineWidth}
          onPointerDown={beginResize} />}
      </>}
      <div className="editor-pane" onKeyDownCapture={resumeOutlineFollowing} onPointerDownCapture={resumeOutlineFollowing}>
        <div className="editor-scroll" onScrollCapture={resumeOutlineFollowing}><div className="editor-content">{children}</div></div>
      </div>
    </div>
    <footer className="status-bar">
      <span>{dirty ? '未保存' : '已保存'}</span>
      <span>{characterCount} 字符</span>
      <span>{mode === 'visual' ? '所见即所得' : '源码模式'}</span>
    </footer>
  </main>;
}
