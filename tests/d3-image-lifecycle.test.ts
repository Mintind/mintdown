import {expect,it} from 'vitest';
import {EditorView} from '@codemirror/view';
import {localPreviewField} from '../src/editor/localPreview';

it('an old image blur callback cannot move the selection in replacement Markdown',async()=>{
  const parent=document.createElement('div');document.body.append(parent);
  const view=new EditorView({parent,doc:'![唯一](old.png)',extensions:[localPreviewField]});
  try{
    view.dispatch({selection:{anchor:2}});
    const input=parent.querySelector<HTMLInputElement>('.md-image-edit-input')!;
    expect(input).not.toBeNull();
    input.dispatchEvent(new FocusEvent('blur'));
    const source='# 标题\n\n![历史](new.png)\n\n正文\n',head=source.indexOf('![历史]')+2;
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:source},selection:{anchor:head}});
    await new Promise(done=>setTimeout(done,20));
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main.head).toBe(head);
    expect(parent.querySelector<HTMLInputElement>('.md-image-edit-input')?.value).toBe('![历史](new.png)');
  }finally{view.destroy();parent.remove();}
});
