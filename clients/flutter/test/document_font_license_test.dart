import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/document_font_license.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'document font licence is retained in the application licence list',
    () async {
      registerDocumentFontLicense();
      final entries = await LicenseRegistry.licenses.toList();
      final font = entries.singleWhere(
        (entry) => entry.packages.contains('Nova Document Sans SC'),
      );
      final text = font.paragraphs
          .map((paragraph) => paragraph.text)
          .join('\n');
      expect(text, contains('SIL OPEN FONT LICENSE Version 1.1'));
      expect(text, contains('Source'));
      expect(text, contains('Adobe'));
    },
  );
}
