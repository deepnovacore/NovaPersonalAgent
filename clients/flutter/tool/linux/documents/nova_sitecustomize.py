"""Alias ReportLab's Helvetica defaults to the approved bundled CJK subset.

Installed as system sitecustomize.py by the rootfs baker. No ReportLab import or
font parsing occurs until the user's script actually requests a ReportLab font.
"""
import os
import sys

_FONT = os.environ.get('NOVA_DOCUMENT_FONT', '/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf')
_TARGET = 'reportlab.pdfbase.pdfmetrics'
_warned = False


def _warn():
    global _warned
    if not _warned:
        _warned = True
        try:
            sys.stderr.write('nova: bundled ReportLab CJK defaults unavailable; check PDF text.\n')
        except Exception:
            pass  # A closed stderr must not break the user's script either.


def _register():
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        fonts = [TTFont(name, _FONT) for name in
                 ('Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique')]
        for font in fonts:
            pdfmetrics.registerFont(font)
    except Exception:
        _warn()


class _Finder:
    def find_spec(self, name, path=None, target=None):
        if name != _TARGET:
            return None
        try:
            import importlib.util
            sys.meta_path.remove(self)
            spec = importlib.util.find_spec(name)
            if spec is None or spec.loader is None:
                return spec
            original = spec.loader.exec_module

            def exec_module(module):
                original(module)
                # canvas/platypus can still be initialising here. Defer TTFont
                # imports until the first lookup to avoid that circular import.
                real_get_font = module.getFont
                registered = False

                def get_font(*args, **kwargs):
                    # reportlab.platypus.paragraph imports getFont by name, so
                    # this wrapper stays reachable; register exactly once.
                    nonlocal registered
                    if not registered:
                        registered = True
                        module.getFont = real_get_font
                        _register()
                    return real_get_font(*args, **kwargs)

                module.getFont = get_font

            spec.loader.exec_module = exec_module
            return spec
        except Exception:
            _warn()
            return None


try:
    if os.path.isfile(_FONT):
        sys.meta_path.insert(0, _Finder())
except Exception:
    _warn()
