import 'dart:async';

/// Identifies the lane (text chat or voice delegate) that started a tool call.
/// The owner travels in the zone so shared native callbacks keep their
/// signature; a cancel from one lane can then never stop another lane's work.
class ToolOwner {
  const ToolOwner._();
  static const text = 'text';
  static const voice = 'voice';
  static const _key = #novaToolOwner;

  /// The lane of the current tool call; direct callers default to [text].
  static String get current => Zone.current[_key] as String? ?? text;

  static Future<T> run<T>(String owner, Future<T> Function() body) =>
      runZoned(body, zoneValues: {_key: owner});

  /// `text` or `voice`, without any lane instance suffix.
  static String lane(String owner) => owner.split(':').first;
}
