"""Host-only hook tests with synthetic ReportLab modules; no host dependencies."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

HOOK = Path(__file__).with_name('nova_sitecustomize.py')


def load_hook():
    spec = importlib.util.spec_from_file_location('nova_test_sitecustomize', HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NovaSitecustomizeTest(unittest.TestCase):
    def test_missing_font_is_noop_without_importing_reportlab(self):
        before = list(sys.meta_path)
        with patch('os.path.isfile', return_value=False):
            load_hook()
        self.assertEqual(sys.meta_path, before)

    def test_registration_failure_warns_once_and_never_writes_stdout(self):
        with patch('os.path.isfile', return_value=False):
            hook = load_hook()
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(sys.modules, {'reportlab.pdfbase': None}), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            hook._register()
            hook._register()
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue().count('CJK defaults unavailable'), 1)
        with patch.object(sys, 'stderr', None):
            hook._warn()

    def test_lookup_defers_registration_and_restores_original_before_registering(self):
        with patch('os.path.isfile', return_value=False):
            hook = load_hook()
        module = types.SimpleNamespace(getFont=lambda name: 'original ' + name)
        loader = types.SimpleNamespace(exec_module=lambda module: None)
        spec = types.SimpleNamespace(loader=loader)
        finder = hook._Finder()
        sys.meta_path.insert(0, finder)
        calls = []
        try:
            with patch('importlib.util.find_spec', return_value=spec), \
                    patch.object(hook, '_register', side_effect=lambda: calls.append(module.getFont('nested'))):
                self.assertIsNone(finder.find_spec('unrelated'))
                self.assertIs(finder.find_spec(hook._TARGET), spec)
                loader.exec_module(module)
                self.assertEqual(calls, [])
                captured = module.getFont  # e.g. `from pdfmetrics import getFont`
                self.assertEqual(module.getFont('Helvetica'), 'original Helvetica')
                module.getFont('Helvetica-Bold')
                self.assertEqual(calls, ['original nested'])
                for _ in range(3):
                    self.assertEqual(captured('Helvetica'), 'original Helvetica')
                self.assertEqual(calls, ['original nested'])
        finally:
            if finder in sys.meta_path:
                sys.meta_path.remove(finder)

    def test_finder_failure_does_not_break_import(self):
        with patch('os.path.isfile', return_value=False):
            hook = load_hook()
        finder = hook._Finder()
        sys.meta_path.insert(0, finder)
        with patch('importlib.util.find_spec', side_effect=RuntimeError), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(finder.find_spec(hook._TARGET))
        self.assertNotIn(finder, sys.meta_path)


if __name__ == '__main__':
    unittest.main()
