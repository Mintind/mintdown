import { afterEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { localPreviewField } from '../src/editor/localPreview';
vi.mock('../src/editor/syntaxHighlight', () => ({ supportedCodeLanguage: () => 'javascript',
  loadHighlightCore: async () => ({codeToTokensWithThemes: (code: string) => [[{content:code,variants:{light:{color:'#123456'},dark:{color:'#abcdef'}}}]]}) }));
vi.mock('../src/editor/localSpelling', () => ({loadLocalSpellChecker: async () => ({correct:()=>false})}));
import { canonicalHighlight } from '../src/editor/canonicalHighlight';
import { canonicalSpelling } from '../src/editor/canonicalSpelling';
let view: EditorView;
afterEach(() => {view?.destroy(); document.body.replaceChildren();});
it.each(['highlight','spelling'])('%s maps existing ranges immediately when the document shrinks, before its debounce', async kind => {
  const parent=document.createElement('div');document.body.append(parent);
  const source=kind==='highlight' ? '正文'.repeat(100)+'\n```javascript\nconst a=1;\n```\n' : '中文'.repeat(100)+' missspelledword';
  view=new EditorView({doc:source,parent,extensions:[localPreviewField,canonicalHighlight,canonicalSpelling]});
  const plugin=kind==='highlight'?view.plugin(canonicalHighlight)!:view.plugin(canonicalSpelling)!;
  await vi.waitFor(()=>expect(plugin.decorations.size).toBeGreaterThan(0),{timeout:3000});
  view.dispatch({changes:{from:0,to:source.length,insert:'正文'}});
  const ranges: number[]=[];plugin.decorations.between(0,1000,(_from,to)=>{ranges.push(to);});
  expect(ranges.every(to=>to<=view.state.doc.length)).toBe(true);
  // A second transaction before the delayed refresh must also be safe.
  expect(()=>view.dispatch({changes:{from:2,insert:'输入'}})).not.toThrow();
  expect(view.state.doc.toString()).toBe('正文输入');
});
