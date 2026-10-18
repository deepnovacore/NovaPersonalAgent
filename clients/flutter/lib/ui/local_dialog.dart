import 'package:flutter/material.dart';

/// Keep form controllers alive until the closing route has left the overlay.
/// Navigator.pop resolves before the dialog's exit animation has finished.
Future<T?> showLocalDialog<T>({
  required BuildContext context,
  required WidgetBuilder builder,
}) async {
  final navigator = Navigator.of(context, rootNavigator: true);
  final route = DialogRoute<T>(
    context: context,
    builder: builder,
    themes: InheritedTheme.capture(from: context, to: navigator.context),
  );
  final result = await navigator.push(route);
  await route.completed;
  return result;
}
