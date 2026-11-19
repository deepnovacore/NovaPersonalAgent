import 'package:flutter/material.dart';

/// Keep form controllers alive until the dialog has finished its exit animation.
Future<T?> showSpaceDialog<T>({
  required BuildContext context,
  required WidgetBuilder builder,
}) async {
  final route = DialogRoute<T>(context: context, builder: builder);
  final result = await Navigator.of(context).push(route);
  await route.completed;
  return result;
}
