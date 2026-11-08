"""Compare actual native export timings and PDF/HTML content, not HTML anchors."""
import hashlib
import json
import statistics
import sys
from pathlib import Path
from pypdf import PdfReader

before, after = map(Path, sys.argv[1:3])
old = json.loads((before / 'results.json').read_text())
new = json.loads((after / 'results.json').read_text())
summary = {'before': str(before), 'after': str(after), 'timings': [], 'documents': []}

def outlines(reader):
    entries = []
    def walk(items, depth=1):
        for item in items:
            if isinstance(item, list):
                walk(item, depth + 1)
            else:
                entries.append([item.title, depth, reader.get_destination_page_number(item), float(item.top or 0)])
    walk(reader.outline)
    return entries

for sample, headings in [('short', 1), ('long', 101), ('images', 1)]:
    html_before = (before / f'{sample}-0.html').read_bytes()
    html_after = (after / f'{sample}-0.html').read_bytes()
    assert html_before == html_after, f'{sample}: export HTML changed'
    pdf_before = PdfReader(before / f'{sample}-0.pdf')
    pdf_after = PdfReader(after / f'{sample}-0.pdf')
    bookmarks = outlines(pdf_after)
    assert len(bookmarks) == headings
    assert bookmarks == outlines(pdf_before), f'{sample}: PDF destinations changed'
    assert len(pdf_before.pages) == len(pdf_after.pages)
    text_before = [page.extract_text() for page in pdf_before.pages]
    text_after = [page.extract_text() for page in pdf_after.pages]
    assert text_before == text_after, f'{sample}: PDF text or pagination changed'
    summary['documents'].append({'sample': sample, 'htmlIdentical': True,
        'htmlSha256': hashlib.sha256(html_after).hexdigest(), 'pages': len(pdf_after.pages),
        'bookmarks': len(bookmarks), 'pdfTextAndDestinationsIdentical': True,
        'images': sum(len(page.images) for page in pdf_after.pages)})
    for fmt in ['html', 'pdf']:
        a = [r for r in old['results'] if r['sample'] == sample and r['format'] == fmt]
        b = [r for r in new['results'] if r['sample'] == sample and r['format'] == fmt]
        median_a, median_b = (statistics.median(r['totalMs'] for r in rows) for rows in [a, b])
        summary['timings'].append({'sample': sample, 'format': fmt,
            'beforeMedianMs': median_a, 'afterMedianMs': median_b,
            'improvementPercent': 100 * (median_a - median_b) / median_a,
            'before': {group: {key: statistics.median(r[group][key] for r in a)
                for key in a[0][group]} for group in ['frontend', 'native']},
            'after': {group: {key: statistics.median(r[group][key] for r in b)
                for key in b[0][group]} for group in ['frontend', 'native']}})
out = after / 'comparison.json'
out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
