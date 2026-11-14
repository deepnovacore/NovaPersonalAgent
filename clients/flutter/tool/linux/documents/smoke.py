#!/usr/bin/env python3
"""Offline document smoke; run with the target rootfs Python, never host Python."""
import argparse
import importlib.metadata
import json
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path


FIRST_IMPORTS = (
    'from reportlab.pdfgen import canvas',
    'from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph',
    'import reportlab.pdfbase.pdfmetrics',
)

# Deliberately no font registration, stylesheets changes or font-path handling.
NAIVE_SCRIPT = r"""
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas
from pypdf import PdfReader
import io, json
from reportlab.pdfbase import ttfonts
inits = []
original_init = ttfonts.TTFont.__init__
def counting_init(self, *args, **kwargs):
    inits.append(args[0])
    original_init(self, *args, **kwargs)
ttfonts.TTFont.__init__ = counting_init
text = '上海 广州 北京 成都 杭州'
output = io.BytesIO()
table = Table([[text, '金额'], ['上海', '41258']])
table.setStyle(TableStyle([('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold')]))
normal = getSampleStyleSheet()['Normal']
# Many paragraphs: platypus captured getFont by name must not re-register per call.
SimpleDocTemplate(output).build([Paragraph(text, normal) for _ in range(30)] + [table])
assert sorted(inits) == ['Helvetica', 'Helvetica-Bold', 'Helvetica-BoldOblique', 'Helvetica-Oblique'], inits
canvas_output = io.BytesIO()
pdf = canvas.Canvas(canvas_output)
for name in ('Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'):
    pdf.setFont(name, 12)
    pdf.drawString(30, 700, text)
    pdf.showPage()
pdf.save()
fonts = []
for data in (output, canvas_output):
    reader = PdfReader(data)
    for page in reader.pages:
        extracted = page.extract_text()
        assert all(city in extracted for city in text.split()), extracted
        assert '■' not in extracted, extracted
        for reference in page['/Resources']['/Font'].values():
            font = reference.get_object()
            base = str(font.get('/BaseFont'))
            descriptor = font.get('/FontDescriptor')
            embedded = bool(descriptor and descriptor.get_object().get('/FontFile2'))
            assert embedded, (base, 'unembedded font')
            fonts.append(base)
print(json.dumps({'passed': True, 'fonts': sorted(set(fonts))}))
"""


def default_font_smoke():
    results = []
    # Each import order needs a fresh interpreter (also exercises site startup).
    for first in FIRST_IMPORTS:
        process = subprocess.run([sys.executable, '-c', first + '\n' + NAIVE_SCRIPT],
                                 capture_output=True, text=True, check=True)
        assert not process.stderr, process.stderr
        results.append({'first_import': first, **json.loads(process.stdout)})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', required=True)
    parser.add_argument('--skip-default-font', action='store_true', help='Unbundled size comparison only')
    args = parser.parse_args()
    start = time.monotonic()
    defaults = None if args.skip_default_font else default_font_smoke()
    from docx import Document
    import openpyxl
    import pypdf
    import reportlab
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen.canvas import Canvas

    imported = time.monotonic()
    versions = {name: importlib.metadata.version(name) for name in
                ['openpyxl', 'et_xmlfile', 'pypdf', 'reportlab', 'pillow', 'charset-normalizer',
                 'python-docx', 'lxml', 'typing_extensions']}
    assert versions == {'openpyxl': '3.1.5', 'et_xmlfile': '2.0.0', 'pypdf': '6.1.1',
                        'reportlab': '4.4.4', 'pillow': '13.0.0', 'charset-normalizer': '3.5.2',
                        'python-docx': '1.2.0', 'lxml': '6.1.3', 'typing_extensions': '4.15.0'}, versions
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        # Fixture creation is not a promise of XLSX writing support in the product.
        workbook = openpyxl.Workbook()
        for i in range(1, 1001):
            workbook.active.append([i, i * 2])
        workbook.save(root / 'input.xlsx')
        workbook.close()
        workbook = openpyxl.load_workbook(root / 'input.xlsx', read_only=True, data_only=True)
        total = sum(row[1] for row in workbook.active.iter_rows(values_only=True))
        workbook.close()
        assert total == 1001000, total
        xlsx_done = time.monotonic()
        pdf = Canvas(str(root / 'input.pdf'), invariant=1)
        for i in range(1, 21):
            pdf.drawString(30, 800, f'Page {i}: document smoke')
            pdf.showPage()
        pdf.save()
        reader = pypdf.PdfReader(root / 'input.pdf')
        assert len(reader.pages) == 20
        for i, page in enumerate(reader.pages, 1):
            assert f'Page {i}: document smoke' in page.extract_text()
        pdf_done = time.monotonic()
        pdfmetrics.registerFont(TTFont('NovaDocumentSmoke', args.font))
        pdf = Canvas(str(root / 'summary.pdf'), invariant=1)
        pdf.setFont('NovaDocumentSmoke', 12)
        text = f'中文汇总：总和 {total}'
        pdf.drawString(30, 800, text)
        pdf.save()
        extracted = pypdf.PdfReader(root / 'summary.pdf').pages[0].extract_text()
        assert text in extracted, extracted
        cjk_done = time.monotonic()
        document = Document()
        document.add_heading('PDF → DOCX', level=1)
        document.add_paragraph(extracted.strip())
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = '总和'
        table.cell(0, 1).text = str(total)
        document.save(root / 'summary.docx')
        document = Document(root / 'summary.docx')
        assert document.paragraphs[1].text == text, document.paragraphs[1].text
        assert [cell.text for cell in document.tables[0].rows[0].cells] == ['总和', '1001000']
    finished = time.monotonic()
    try:
        maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss or None
    except OSError:
        maxrss = None  # iSH may not implement getrusage; unavailable is not zero.
    print(json.dumps({'passed': True, 'versions': versions, 'xlsx_total': total,
                      'pdf_pages': 20, 'cjk_text': text, 'default_fonts': defaults,
                      'docx_text': document.paragraphs[1].text,
                      'seconds': {'import': imported - start, 'xlsx': xlsx_done - imported,
                                  'pdf': pdf_done - xlsx_done, 'cjk': cjk_done - pdf_done,
                                  'docx': finished - cjk_done,
                                  'total': finished - start},
                      'maxrss_kib': maxrss},
                     ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
