import assert from 'node:assert/strict';

export const styleProperties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderTopColor',
  'borderRightWidth', 'borderRightColor', 'borderRadius', 'boxShadow', 'outlineColor', 'outlineWidth'];
export const measureExpression = `(() => {
  const panel='.document-tab-panel:not([hidden])',el=s=>document.querySelector(s),rect=s=>{const r=el(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}},
    style=s=>{const c=getComputedStyle(el(s));return Object.fromEntries(${JSON.stringify(styleProperties)}.map(p=>[p,c[p]]))};
  return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    layout:{menu:rect(panel+' .app-menu-bar'),tabs:rect('.document-tabs'),sidebar:rect(panel+' .outline-sidebar'),editor:rect(panel+' .editor-pane')},
    styles:{menu:style(panel+' .app-menu-bar'),trigger:style(panel+' .menu-trigger'),tab:style('.document-tab'),tabLabel:style('.document-tab [role="tab"]'),
      sidebar:style(panel+' .outline-sidebar'),outline:style(panel+' .outline-list button:not(.active)'),active:style(panel+' .outline-list button.active')},
    outlineRect:rect(panel+' .outline-list button.active')};
})()`;

export function assertOutline(active, regular, label = 'outline') {
  const background = active.backgroundColor ?? active.background, shadow = active.boxShadow ?? active.shadow;
  assert.ok(['color(srgb 0.879412 0.940196 0.913725)', 'color(srgb 0.189216 0.237255 0.357843)'].includes(background), `${label}: current chapter requires d58ce8d compact background`);
  assert.equal(shadow, 'none', `${label}: current chapter must not have a stripe`);
  assert.equal(Number(active.fontWeight ?? active.weight), 600, `${label}: current chapter weight`);
  assert.ok(Number(regular.fontWeight ?? regular.weight) < 600, `${label}: regular item must remain lighter`);
}
export function assertTab(active, label = 'tab') {
  assert.ok(['color(srgb 0.96502 0.975686 0.966902)', 'color(srgb 0.136471 0.152157 0.225725)'].includes(active.backgroundColor), `${label}: requires d58ce8d compact background`);
  assert.equal(active.boxShadow, 'none', `${label}: no active accent line`);
}
// Density-independent, explicitly approved highlight semantics. Geometry and
// typography remain protected separately by computed.json and layout assertions.
export const highlightProperties = ['backgroundColor', 'color', 'fontWeight', 'opacity', 'boxShadow',
  'borderLeftWidth', 'borderTopWidth', 'borderTopColor', 'borderRightWidth', 'borderRightColor',
  'borderBottomWidth', 'borderBottomColor', 'borderRadius'];
export const highlightExpression = `(() => {const panel='.document-tab-panel:not([hidden])',selectors={
  outlineActive:panel+' .outline-list button.active',outlineOther:panel+' .outline-list button:not(.active)',
  tabActive:'.document-tab:first-child',tabActiveLabel:'.document-tab:first-child [role="tab"]',
  tabOther:'.document-tab:nth-child(2)',tabOtherLabel:'.document-tab:nth-child(2) [role="tab"]'};
  return Object.fromEntries(Object.entries(selectors).map(([k,s])=>{const c=getComputedStyle(document.querySelector(s));
    return [k,Object.fromEntries(${JSON.stringify(highlightProperties)}.map(p=>[p,c[p]]))]}));})()`;
export function assertLayout(layout) {
  const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 0.5, `${label}: ${a} vs ${b}`);
  near(layout.menu.x, 0, 'menu full width origin');
  near(layout.sidebar.y, layout.tabs.y, 'sidebar starts beside tabs');
  near(layout.tabs.x, layout.editor.x, 'tabs align with editor');
  near(layout.sidebar.x + layout.sidebar.width, layout.editor.x, 'sidebar ends at editor');
  near(layout.tabs.width, layout.editor.width, 'tabs/editor width');
  near(layout.tabs.height, 34, 'fixed tab height');
  near(layout.tabs.y + layout.tabs.height, layout.editor.y, 'editor below tabs');
}
export function assertMetrics(actual, expected, path = 'ui') {
  if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) <= 0.5, `${path}: ${actual} vs ${expected}`);
  else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: metric schema`);
    for (const key of Object.keys(expected)) assertMetrics(actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, `${path}: computed style changed`);
}
