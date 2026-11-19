// Runs inside the device's Alpine, never on the development host.
const documentAcceptanceScript = r'''
import hashlib, importlib.metadata, json, os, pathlib, platform, ssl, subprocess, sys, time, traceback, urllib.request
BASE = pathlib.Path(sys.argv[1])
BASE.mkdir(parents=True, exist_ok=True)
INDEX = sys.argv[2] if len(sys.argv) > 2 else 'https://pypi.org/simple'
results = []
def memory():
    try:
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value if value > 0 else None
    except Exception:
        return None

def record(name, fn):
    start = time.monotonic()
    item = {'name': name}
    try:
        item.update(fn() or {})
        item.setdefault('passed', True)
    except Exception as e:
        item.update(passed=False, error=str(e), traceback=traceback.format_exc()[-2000:])
    item.update(wall_seconds=round(time.monotonic()-start, 3), peak_rss_kib=memory())
    results.append(item)
    print('DOCUMENT_MEASUREMENT '+json.dumps(item, ensure_ascii=False), flush=True)

def tls_probe():
    detail = {'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'openssl': ssl.OPENSSL_VERSION, 'verify_paths': str(ssl.get_default_verify_paths()),
              'ca_count': len(ssl.create_default_context().get_ca_certs()), 'probes': []}
    for url in ['https://pypi.org/simple/openpyxl/', INDEX+'/openpyxl/']:
        start = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                detail['probes'].append({'url': url, 'status': response.status, 'seconds': round(time.monotonic()-start, 3)})
        except Exception as e:
            detail['probes'].append({'url': url, 'error': str(e), 'seconds': round(time.monotonic()-start, 3)})
    return detail
record('tls_diagnostics', tls_probe)

# ReportLab is installed before fpdf2 so its dependency result is independent.
for package in ['openpyxl==3.1.5', 'pypdf==6.1.1', 'reportlab==4.4.4', 'fpdf2==2.8.4']:
    def install(package=package):
        name = package.split('==')[0]
        report = BASE / (name+'-pip.json')
        log = BASE / (name+'-install.log')
        args = [sys.executable, '-m', 'pip', 'install', '--index-url', INDEX, '--disable-pip-version-check', '--retries', '1', '--timeout', '30', '--report', str(report), package]
        start = time.monotonic()
        with log.open('w') as out:
            binary = subprocess.run(args + ['--only-binary=:all:'], stdout=out, stderr=subprocess.STDOUT)
            fallback = binary.returncode != 0
            code = subprocess.run(args, stdout=out, stderr=subprocess.STDOUT).returncode if fallback else binary.returncode
        detail = {'exit_code': code, 'binary_only': not fallback, 'install_seconds': round(time.monotonic()-start, 3), 'log': str(log)}
        if report.exists():
            detail['downloads'] = [{'url': i['download_info']['url'], 'sha256': i['download_info'].get('archive_info', {}).get('hashes', {}).get('sha256')} for i in json.loads(report.read_text()).get('install', [])]
        try:
            import resource
            detail['installer_peak_rss_kib'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss or None
        except Exception:
            detail['installer_peak_rss_kib'] = None
        detail['native_extensions'] = [str(p.relative_to(pathlib.Path(sys.prefix))) for p in pathlib.Path(sys.prefix).rglob('*.so')]
        if code:
            detail['passed'] = False
            detail['error'] = log.read_text()[-3000:]
        return detail
    # Installation failure is recorded without preventing the other candidates.
    record('install_'+package, install)
    if results[-1].get('exit_code', 0):
        results[-1]['passed'] = False

def xlsx():
    from openpyxl import Workbook, load_workbook
    path = BASE/'sales.xlsx'
    book = Workbook(write_only=True)
    sheet = book.create_sheet('sales')
    sheet.append(['id', 'amount'])
    for i in range(1, 1001): sheet.append([i, i*2])
    book.save(path)
    book = load_workbook(path, read_only=True, data_only=True)
    rows = list(book.active.iter_rows(min_row=2, values_only=True))
    total = sum(r[1] for r in rows)
    book.close()
    assert len(rows) == 1000 and total == 1001000
    (BASE/'summary.json').write_text(json.dumps({'rows': len(rows), 'total': total}))
    return {'rows': len(rows), 'total': total, 'fixture_bytes': path.stat().st_size}
record('xlsx_1000_summary', xlsx)

def pdf20():
    from pypdf import PdfReader, PdfWriter
    # Generate a small text PDF directly: reading does not depend on a PDF writer candidate.
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    kids = []
    for i in range(20):
        page = len(objects)+1
        kids.append(f'{page} 0 R')
        content = f'BT /F1 12 Tf 40 700 Td (Paper page {i+1}: evidence and results.) Tj ET'.encode()
        objects += [f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {page+1} 0 R >>'.encode(), b'<< /Length '+str(len(content)).encode()+b' >>\nstream\n'+content+b'\nendstream']
    objects[1] = ('<< /Type /Pages /Count 20 /Kids ['+' '.join(kids)+'] >>').encode()
    data = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    for offset in offsets[1:]: data += f'{offset:010d} 00000 n \n'.encode()
    data += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()
    path = BASE/'paper.pdf'; path.write_bytes(data)
    reader = PdfReader(path)
    assert len(reader.pages) == 20
    for i, page in enumerate(reader.pages): assert f'Paper page {i+1}:' in page.extract_text()
    return {'pages': len(reader.pages), 'fixture_bytes': len(data)}
record('pdf_20_pages_read', pdf20)

def font():
    path = BASE/'NotoSansSC.ttf'
    cache = BASE.parent.parent/'.nova/document-acceptance-font.ttf'
    expected = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
    url = 'https://raw.githubusercontent.com/google/fonts/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf'
    cached = cache.exists() and hashlib.sha256(cache.read_bytes()).hexdigest() == expected
    errors = []
    if cached:
        data = cache.read_bytes()
    else:
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=90) as response:
                    data = response.read()
                assert hashlib.sha256(data).hexdigest() == expected, 'font SHA-256 mismatch'
                break
            except Exception as e:
                errors.append(str(e))
                if attempt == 2: raise
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(data)
    assert hashlib.sha256(data).hexdigest() == expected
    path.write_bytes(data)
    from fontTools.ttLib import TTFont
    with TTFont(str(path)) as font:
        tables = list(font.keys())
    return {'bytes': path.stat().st_size, 'measurement_only': True,
            'cache_hit': cached, 'download_errors': errors,
            'tables': tables, 'sha256': expected}
record('download_measurement_font', font)

def chinese(writer):
    from pypdf import PdfReader
    summary = json.loads((BASE/'summary.json').read_text())
    text = f"数据汇总：共{summary['rows']}行，合计{summary['total']}。"
    path = BASE/(writer+'-summary.pdf')
    if writer == 'fpdf2':
        from fpdf import FPDF
        pdf = FPDF(); pdf.add_page()
        pdf.add_font('Noto', fname=str(BASE/'NotoSansSC.ttf'))
        pdf.set_font('Noto', size=14); pdf.multi_cell(0, 10, text); pdf.output(str(path))
    else:
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        pdfmetrics.registerFont(TTFont('Noto', str(BASE/'NotoSansSC.ttf')))
        pdf = canvas.Canvas(str(path)); pdf.setFont('Noto', 14); pdf.drawString(40, 700, text); pdf.save()
    extracted = ''.join(p.extract_text() for p in PdfReader(path).pages)
    assert text in extracted, repr(extracted)
    return {'bytes': path.stat().st_size, 'extracted': extracted}
for writer in ['fpdf2', 'reportlab']:
    record(writer+'_cjk_pdf_roundtrip', lambda writer=writer: chinese(writer))
def render_static_fpdf():
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    font = TTFont(str(BASE/'NotoSansSC.ttf'))
    instantiateVariableFont(font, {'wght': 400}, inplace=True)
    assert 'fvar' not in font and 'avar' not in font
    font.save(str(BASE/'NotoSansSC-static.ttf')); font.close()
    from fpdf import FPDF
    from pypdf import PdfReader
    text = '数据汇总：共1000行，合计1001000。'
    pdf = FPDF(); pdf.add_page()
    pdf.add_font('StaticNoto', fname=str(BASE/'NotoSansSC-static.ttf'))
    pdf.set_font('StaticNoto', size=14); pdf.multi_cell(0, 10, text)
    path = BASE/'fpdf2-static.pdf'; pdf.output(str(path))
    extracted = ''.join(p.extract_text() for p in PdfReader(path).pages)
    assert text in extracted, repr(extracted)
    return {'extracted': extracted, 'bytes': path.stat().st_size, 'diagnostic_only': True}
def static_fpdf():
    import inspect
    # Diagnostic only: never let a full CJK variable-font conversion monopolise
    # iSH for the fixture's 30-minute outer timeout.
    code = ('import pathlib, sys, json\nBASE = pathlib.Path(sys.argv[1])\n' +
            inspect.getsource(render_static_fpdf) +
            '\nprint(json.dumps(render_static_fpdf(), ensure_ascii=False))')
    child = subprocess.run([sys.executable, '-c', code, str(BASE)],
                           capture_output=True, text=True, timeout=120)
    if child.returncode:
        raise RuntimeError(child.stderr[-2000:])
    detail = json.loads(child.stdout)
    try:
        import resource
        detail['child_peak_rss_kib'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss or None
    except Exception:
        detail['child_peak_rss_kib'] = None
    return detail
record('fpdf2_static_font_diagnostic', static_fpdf)
report = {'platform': platform.platform(), 'python': sys.version, 'index_url': INDEX, 'measurements': results, 'memory_note': 'Linux ru_maxrss KiB, process high-water mark, not per-case delta. Null means unavailable; installer value is cumulative child high-water mark.', 'passed': all(r['passed'] for r in results)}
(BASE/'document-report.json').write_text(json.dumps(report, ensure_ascii=False))
print('DOCUMENT_ACCEPTANCE_JSON '+json.dumps(report, ensure_ascii=False), flush=True)
''';
