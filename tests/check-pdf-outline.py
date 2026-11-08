"""Check actual PDF destinations, independent of the export HTML."""
import json
import sys
import re
from pathlib import Path
from pypdf import PdfReader
import pdfplumber

path = Path(sys.argv[1])
reader = PdfReader(path)
entries = []

def walk(items, depth=1):
    for item in items:
        if isinstance(item, list):
            walk(item, depth + 1)
        else:
            page = reader.get_destination_page_number(item)
            assert page is not None and 0 <= page < len(reader.pages)
            assert item.typ == '/XYZ', item
            assert item.top is not None and 0 <= float(item.top) <= float(reader.pages[page].mediabox.top)
            entries.append({'title': item.title, 'depth': depth, 'page': page + 1,
                            'left': float(item.left), 'top': float(item.top),
                            'pageHeight': float(reader.pages[page].mediabox.height)})

walk(reader.outline)
expected = [('标题与正文', 1), ('长文档分页检查', 2), ('重复标题 code', 3),
            ('四级中文', 4), ('五级中文', 5), ('六级中文', 6), ('重复标题 code', 3)]
assert [(e['title'], e['depth']) for e in entries] == expected, entries
assert entries[2]['top'] != entries[6]['top'] or entries[2]['page'] != entries[6]['page']
assert not PdfReader(path.parent / 'no-headings.pdf').outline
assert len(reader.pages) >= 5
with pdfplumber.open(path) as document:
    for entry in entries:
        page = document.pages[entry['page'] - 1]
        matches = page.search(re.escape(entry['title']).replace(r'\ ', r'\s+'))
        target_top = page.height - entry['top']
        assert matches and min(abs(match['top'] - target_top) for match in matches) < 20, entry
        entry['headingTextTop'] = min(matches, key=lambda match: abs(match['top'] - target_top))['top']
text = ''.join(page.extract_text() for page in reader.pages)
assert '第 46 行中文' in text and '未保存导出标记' in text and '第 24 段' in text
result = {'pages': len(reader.pages), 'bookmarks': entries, 'textCharacters': len(text)}
if len(sys.argv) > 2:
    with pdfplumber.open(sys.argv[2]) as before, pdfplumber.open(path) as after:
        assert len(before.pages) == len(after.pages)
        comparison = []
        for index, (old, new) in enumerate(zip(before.pages, after.pages)):
            assert ''.join(c['text'] for c in old.chars) == ''.join(c['text'] for c in new.chars)
            assert len(old.images) == len(new.images)
            dx = max(abs(a['x0'] - b['x0']) for a, b in zip(old.chars, new.chars))
            dy = max(abs(a['top'] - b['top']) for a, b in zip(old.chars, new.chars))
            assert dx < 1.1 and dy < 1.1, (index, dx, dy)
            comparison.append({'page': index + 1, 'textIdentical': True, 'images': len(new.images),
                               'maxDxPt': dx, 'maxDyPt': dy})
        result['layoutComparison'] = comparison
path.with_suffix('.outline.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(result, ensure_ascii=True, indent=2))
