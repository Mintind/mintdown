import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/** Markdown source colors are theme variables so raw URLs remain readable in both modes. */
export const markdownHighlight = HighlightStyle.define([
  { tag: tags.meta, color: 'var(--muted)' },
  { tag: tags.link, color: 'var(--link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--link)' },
  // The visual heading line supplies its level color through this inherited
  // variable; source mode keeps the theme's default heading color.
  { tag: tags.heading, color: 'var(--heading-inline)', fontWeight: 'var(--font-weight-editor-bold)' },
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.character, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syntax-comment)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.propertyName], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'var(--font-weight-editor-bold)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);
