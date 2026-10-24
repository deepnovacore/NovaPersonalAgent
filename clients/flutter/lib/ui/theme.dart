import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

/// Quiet surfaces, readable ink and a restrained green accent.
abstract final class Nova {
  static const ink = Color(0xffffffff),
      inkTop = Color(0xffffffff),
      cell = Color(0xfff6f7f8),
      cellPressed = Color(0xffebeeef),
      sheet = Color(0xfff2f3f5),
      sheetCell = Color(0xffffffff),
      separator = Color(0xffe7e9ec),
      text = Color(0xff202529),
      secondary = Color(0xff6e767c),
      tertiary = Color(0xff9ba2a8),
      mint = Color(0xff237c68),
      amber = Color(0xff956516),
      red = Color(0xffbd4545);
}

const novaBackground = BoxDecoration(color: Nova.ink);

// Match desktop workbench.css timeline and default brief colors.
const novaTimelineAccent = Color(0xff087fae);
const novaTimelineWash = Color(0xffe9f5fb);
const novaTimelineBackground = BoxDecoration(
  gradient: LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xffe8f0f9), Color(0xfff4f5f7), Color(0xfff7efe5)],
    stops: [0, .42, 1],
  ),
);

ThemeData novaTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Nova.mint,
    brightness: Brightness.light,
    primary: Nova.mint,
    onPrimary: Nova.ink,
    surface: Nova.ink,
    onSurface: Nova.text,
    error: Nova.red,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: scheme,
    scaffoldBackgroundColor: Colors.transparent,
    canvasColor: Nova.ink,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.black.withValues(alpha: .03),
    dividerColor: Nova.separator,
    textTheme: Typography.blackCupertino.apply(
      bodyColor: Nova.text,
      displayColor: Nova.text,
    ),
    cupertinoOverrideTheme: const CupertinoThemeData(
      brightness: Brightness.light,
      primaryColor: Nova.mint,
      scaffoldBackgroundColor: Nova.ink,
      barBackgroundColor: Color(0xfaffffff),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleSpacing: 20,
      toolbarHeight: 60,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Nova.sheet,
      surfaceTintColor: Colors.transparent,
      showDragHandle: false,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Nova.sheetCell,
      contentTextStyle: const TextStyle(color: Nova.text, fontSize: 15),
      actionTextColor: Nova.mint,
      elevation: 0,
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Nova.sheet,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      titleTextStyle: const TextStyle(
        color: Nova.text,
        fontSize: 18,
        fontWeight: FontWeight.w600,
      ),
      contentTextStyle: const TextStyle(
        color: Nova.text,
        fontSize: 15,
        height: 1.4,
      ),
    ),
    // Plain Material widgets inherit the same quiet, rounded look as the
    // grouped lists, so screens that have not been rebuilt still match.
    cardTheme: CardThemeData(
      color: Nova.cell,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    listTileTheme: const ListTileThemeData(
      iconColor: Nova.secondary,
      textColor: Nova.text,
      contentPadding: EdgeInsets.symmetric(horizontal: 16),
      minVerticalPadding: 10,
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: Nova.sheetCell,
      surfaceTintColor: Colors.transparent,
      elevation: 6,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      textStyle: const TextStyle(color: Nova.text, fontSize: 15),
    ),
    expansionTileTheme: const ExpansionTileThemeData(
      iconColor: Nova.secondary,
      collapsedIconColor: Nova.tertiary,
    ),
    chipTheme: ChipThemeData(
      backgroundColor: Nova.cell,
      selectedColor: Nova.mint.withValues(alpha: .14),
      checkmarkColor: Nova.mint,
      side: BorderSide.none,
      shape: const StadiumBorder(),
      labelStyle: const TextStyle(color: Nova.text, fontSize: 14),
    ),
    dividerTheme: const DividerThemeData(color: Nova.separator, thickness: .5),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Nova.mint,
        side: BorderSide(color: Nova.mint.withValues(alpha: .5)),
        shape: const StadiumBorder(),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Nova.sheetCell,
      hintStyle: const TextStyle(color: Nova.tertiary),
      labelStyle: const TextStyle(color: Nova.secondary),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide.none,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: Nova.mint,
        textStyle: const TextStyle(
          fontFamily: 'CupertinoSystemText',
          fontSize: 15,
          fontWeight: FontWeight.w500,
        ),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Nova.mint,
        foregroundColor: Nova.ink,
        disabledBackgroundColor: Nova.mint.withValues(alpha: .18),
        disabledForegroundColor: Nova.mint.withValues(alpha: .4),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(
          fontFamily: 'CupertinoSystemText',
          fontSize: 16,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: Nova.mint,
      foregroundColor: Nova.ink,
      elevation: 0,
      highlightElevation: 0,
      shape: CircleBorder(),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Nova.mint),
  );
}
