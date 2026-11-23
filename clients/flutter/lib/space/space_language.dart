import 'package:flutter/widgets.dart';

/// The platform language, reduced to the two the Space UI ships.
String spacePlatformLanguage() =>
    WidgetsBinding.instance.platformDispatcher.locale.languageCode == 'zh'
    ? 'zh'
    : 'en';

/// Picks the Chinese or English text by the platform language, for code that
/// has no widget language of its own (push and adapter status messages).
String spaceText(String zh, String en) =>
    spacePlatformLanguage() == 'zh' ? zh : en;
