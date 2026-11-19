import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

void registerDocumentFontLicense() {
  LicenseRegistry.addLicense(() async* {
    final text = await rootBundle.loadString(
      'assets/licenses/NovaDocumentSansSC-OFL.txt',
    );
    yield LicenseEntryWithLineBreaks(const ['Nova Document Sans SC'], text);
  });
}
