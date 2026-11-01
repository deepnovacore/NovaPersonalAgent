// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: copy of PhoneSetupCopy.kt and
// the self-check advice strings, reworded for Nova and keyed by the
// nova/phone/v1 status and self-check codes.
import '../agent/phone_channel.dart';

/// Plain-language copy for the phone-control page, the setup wizard and the
/// self-check. It uses only words that exist in Android's settings; "port" and
/// "adb" appear only where the user must read a number off the system screen.
class PhoneCopy {
  const PhoneCopy(this.language);
  final String language;
  String t(String zh, String en) => language == 'zh' ? zh : en;

  // ---------- page ----------
  String get title => t('手机操作', 'Phone control');
  String get intro => t(
    'Nova 可以在一块单独的虚拟屏上替你操作 App，你照常用手机。为此要借用安卓自带的「无线调试」：配对一次就行，之后会自动连接，不需要电脑。网页和文件类的事不受影响，不设置也能做。开发者选项里没提到的开关都不要动，有的会清除手机数据。',
    'Nova can use apps for you on a separate virtual screen while you keep using your phone. For this it borrows Android’s built-in “Wireless debugging”: pair once and it connects automatically from then on, no computer needed. Web and file tasks work without this. Don’t change any other switch in Developer options: some can erase your phone.',
  );
  String get statusHeader => t('状态', 'Status');
  String get accessibility => t('无障碍', 'Accessibility');
  String get accessibilitySub =>
      t('读取屏幕上的内容并点按', 'Reads the screen and taps for you');
  String get overlay => t('悬浮窗', 'Display over other apps');
  String get overlaySub =>
      t('在别的 App 上显示任务进度', 'Shows task progress over other apps');
  String get battery => t('后台不被杀', 'Keep running in background');
  String get batterySub =>
      t('长任务不会被系统停掉', 'Stops the system from ending long tasks');
  String get notifications => t('通知', 'Notifications');
  String get notificationsSub =>
      t('配对码、任务进度和「需要你」的提醒', 'Pairing code, progress and “needs you” alerts');
  String get pairing => t('无线调试配对', 'Wireless debugging pairing');
  String get helper => t('助手状态', 'Helper');
  String get systemVersion => t('系统版本', 'System version');
  String get on => t('已开启', 'On');
  String get off => t('未开启', 'Off');
  String get allowed => t('已允许', 'Allowed');
  String get notAllowed => t('未允许', 'Not allowed');
  String get goOpen => t('去打开', 'Open');
  String get paired => t('已配对', 'Paired');
  String get unpaired => t('未配对', 'Not paired');
  String get searching => t('正在查找', 'Looking');
  String get unavailable =>
      t('暂时读不到手机状态。', 'Can’t read the phone status right now.');
  String get retry => t('重试', 'Retry');
  String get setUp => t('设置向导', 'Setup guide');
  String get setUpSub =>
      t('一步步打开所需的开关并配对', 'Turn on the switches and pair, step by step');
  String get setUpContinue => t('继续设置', 'Continue setup');
  String get channelHeader => t('配对', 'Pairing');
  String get repair => t('重新配对', 'Pair again');
  String get repairSub => t(
    '连不上、或换了手机设置时用',
    'If it won’t connect, or after changing phone settings',
  );
  String get unpair => t('解除配对', 'Unpair');
  String get unpairSub =>
      t('删除配对，停止手机操作', 'Delete the pairing and stop phone control');
  String get unpairTitle => t('解除配对？', 'Unpair?');
  String get unpairBody => t(
    'Nova 会删掉配对信息，停止在虚拟屏上操作 App。网页和文件类的事不受影响。以后要操作手机 App，需要重新配对一次。你也可以到系统的「无线调试 → 已配对的设备」里把 Nova 删掉。',
    'Nova will delete the pairing and stop using apps on the virtual screen. Web and file tasks aren’t affected. To use apps again later you’ll need to pair once more. You can also remove Nova under “Wireless debugging → Paired devices” in system settings.',
  );
  String get cancel => t('取消', 'Cancel');
  String get unpairConfirm => t('解除', 'Unpair');
  String get usageNote => t(
    '配对一次之后，Nova 的内置助手会常驻后台，断开 Wi-Fi 也能继续操作手机。手机重启后，连上 Wi-Fi 并打开「无线调试」，Nova 会自己重新连上，不用再输配对码。',
    'After pairing once, Nova’s built-in helper stays in the background and keeps working even without Wi-Fi. After a restart, join Wi-Fi and turn on “Wireless debugging” and Nova reconnects by itself, no new code needed.',
  );
  String get actionFailed => t('操作没有成功，请重试。', 'That didn’t work. Try again.');

  // ---------- system version ----------
  static String androidRelease(int api) => switch (api) {
    <= 0 => '',
    24 => '7.0',
    25 => '7.1',
    26 => '8.0',
    27 => '8.1',
    28 => '9',
    29 => '10',
    30 => '11',
    31 => '12',
    32 => '12L',
    33 => '13',
    34 => '14',
    35 => '15',
    36 => '16',
    _ => api > 36 ? '${api - 20}' : '$api',
  };
  String versionLine(int api) {
    final release = androidRelease(api);
    if (release.isEmpty || (api < 24 || api > 36)) {
      return t('安卓 API $api', 'Android API $api');
    }
    return t('安卓 $release', 'Android $release');
  }

  String get versionOk => t('满足要求', 'Supported');
  String get versionTooOld => t('不支持', 'Not supported');
  String get versionExperimental => t('实验支持', 'Experimental');
  String get tooOldLine => t(
    '系统低于安卓 12，不能用虚拟屏；Nova 会在当前屏幕上操作 App，和以前一样。',
    'Below Android 12 there is no virtual screen; Nova uses apps on the current screen, as before.',
  );
  String get experimentalTitle =>
      t('安卓 12、13 上是实验功能', 'Experimental on Android 12 and 13');
  String get experimentalBody => t(
    '在后台操作 App 时，你屏幕上的输入焦点可能短暂丢失，比如正在打字时被打断。建议用安卓 14 及以上。',
    'While Nova works in the background, the keyboard focus on your screen can be taken for a moment, for example while you type. Android 14 or later works best.',
  );
  String get experimentalWizardNote => t(
    '还差一步：安卓 12、13 上要先确认下面的提醒，确认前 Nova 仍在当前屏幕上操作 App。',
    'One more step: on Android 12 and 13 confirm the note below first. Until then Nova keeps using apps on your current screen.',
  );
  String get experimentalAck => t('我知道了，仍要使用', 'I understand, use it anyway');
  String get experimentalAcked => t('已确认，仍要使用', 'Acknowledged');

  // ---------- helper status ----------
  String helperValue(PhoneStatus s) => switch (s.helper) {
    HelperState.running => t('已连接', 'Connected'),
    HelperState.notPaired => t('未设置', 'Not set up'),
    HelperState.wirelessDebuggingOff => t('无线调试已关', 'Wireless debugging off'),
    HelperState.connecting => t('正在连接', 'Connecting'),
    HelperState.failed => t('出错了', 'Error'),
    HelperState.unsupported => t('不支持', 'Not supported'),
  };

  String helperLine(PhoneStatus s) => switch (s.helper) {
    HelperState.running => t('已连接，能操作手机 App', 'Connected and able to use apps'),
    HelperState.notPaired => t(
      '还没配对，操作手机 App 前要设置一次',
      'Not paired yet; set it up once before using apps',
    ),
    HelperState.wirelessDebuggingOff => t(
      '已配对；打开无线调试后会自动连上',
      'Paired; connects automatically once Wireless debugging is on',
    ),
    HelperState.connecting => t('正在连接', 'Connecting'),
    HelperState.failed => failure(
      s.helperFailure ?? HelperFailure.unknown,
    ).title,
    HelperState.unsupported => tooOldLine,
  };

  ({String title, String body}) failure(HelperFailure f) => switch (f) {
    HelperFailure.wrongCode => (
      title: t('配对码不对或已过期', 'Wrong or expired pairing code'),
      body: t(
        '每次打开配对窗口，配对码都会换。请重新点「使用配对码配对设备」，填新的 6 位数字。',
        'The code changes each time the pairing window opens. Tap “Pair device with pairing code” again and enter the new 6 digits.',
      ),
    ),
    HelperFailure.pairingWindowClosed => (
      title: t('配对窗口关掉了', 'The pairing window closed'),
      body: t(
        '填配对码时，那个显示配对码的窗口要一直开着。请重新打开它再填一次。',
        'Keep the window showing the code open while you enter it. Open it again and retry.',
      ),
    ),
    HelperFailure.noWifi => (
      title: t('没有连上 Wi-Fi', 'Not connected to Wi-Fi'),
      body: t(
        'Nova 要借 Wi-Fi 启动手机操作（不用能上网）。连上任意一个 Wi-Fi 后会自动恢复，不用再点。',
        'Nova needs Wi-Fi to start phone control (no internet needed). It resumes by itself once you join any Wi-Fi.',
      ),
    ),
    // Reserved: the contract never reports it (no network-specific refusal can
    // be detected); kept so an unknown future status still reads sensibly.
    HelperFailure.wifiNotAllowed => (
      title: t(
        '这个 Wi-Fi 还没允许无线调试',
        'Wireless debugging isn’t allowed on this Wi-Fi yet',
      ),
      body: t(
        '请亲手打开一次「无线调试」，系统问要不要允许时勾选「始终允许使用此网络」再点允许。',
        'Turn on “Wireless debugging” yourself once; when asked, tick “Always allow on this network” and tap Allow.',
      ),
    ),
    HelperFailure.connectFailed => (
      title: t('没能连上无线调试', 'Couldn’t connect to Wireless debugging'),
      body: t(
        '可以：关掉再打开「无线调试」后重试；或换用手机热点或家里的 Wi-Fi。',
        'You can: turn “Wireless debugging” off and on again, then retry; or switch to a phone hotspot or your home Wi-Fi.',
      ),
    ),
    HelperFailure.authorizationRevoked => (
      title: t('配对失效了', 'Pairing expired'),
      body: t(
        '可能很久没用被系统收回了，或者在系统里删掉了。重新配对一次就好。在开发者选项里打开「停用 adb 授权超时功能」，以后就不会再失效。',
        'The system may have revoked it after a long time unused, or it was removed. Just pair again. Turn on “Disable adb authorization timeout” in Developer options so it won’t expire again.',
      ),
    ),
    HelperFailure.keyUnreadable => (
      title: t('配对用的密钥读不出来了', 'Pairing key can’t be read'),
      body: t(
        'Nova 读不出配对时用的那把密钥了，需要重新配对一次。',
        'Nova can no longer read the key it used for pairing. Pair again once.',
      ),
    ),
    HelperFailure.helperStartFailed => (
      title: t('连上了，但没能准备好', 'Connected, but couldn’t get ready'),
      body: t('通常重试一次就好。', 'Retrying usually fixes it.'),
    ),
    HelperFailure.unknown => (
      title: t('出了点问题', 'Something went wrong'),
      body: t(
        '先重试一次；还不行就重新配对。',
        'Retry first; if that doesn’t work, pair again.',
      ),
    ),
  };

  String fixLabel(HelperFix fix) => switch (fix) {
    HelperFix.retry => t('重试', 'Retry'),
    HelperFix.rePair => t('重新配对', 'Pair again'),
    HelperFix.openWifi => t('打开 Wi-Fi 设置', 'Open Wi-Fi settings'),
    HelperFix.openWirelessDebugging => t(
      '去打开无线调试',
      'Turn on Wireless debugging',
    ),
  };

  // ---------- wizard ----------
  String get wizardIntroSkip => t(
    '也可以先跳过，只用上网、文件和聊天；第一次要操作 App 时会再提醒。',
    'You can skip this for now and just use web, files and chat; Nova will remind you the first time it needs an app.',
  );
  String get later => t('稍后再说', 'Not now');
  String get turnedOnNext => t('我已经打开了，下一步', 'I’ve turned it on, next');
  String get revisitNote =>
      t('点上面任一步，可以回去重做。', 'Tap any step above to go back and redo it.');
  String get done => t('完成', 'Done');
  String get stepFailedLabel => t('出错了', 'Needs attention');
  String get success => t('手机操作已经设置好了', 'Phone control is set up');
  String get successNote => t(
    '手机重启后，连上 Wi-Fi 并打开「无线调试」即可自动重连。',
    'After a restart, join Wi-Fi and turn on “Wireless debugging” and it reconnects automatically.',
  );
  String get working =>
      t('正在配对并连接，几秒钟就好', 'Pairing and connecting, just a few seconds');
  String get scanning =>
      t('正在本机查找无线调试…', 'Looking for Wireless debugging on this phone…');
  String get portFound => t(
    '已找到配对窗口，请在通知里填写配对码。',
    'Found the pairing window. Enter the code in the notification.',
  );
  String get autoRead => t(
    '看到配对码后稍等几秒，Nova 会自己读出来并完成配对，不用离开那个页面。',
    'When the code appears, wait a few seconds: Nova reads it and finishes pairing. No need to leave that page.',
  );
  List<String> get notifyGuide => [
    t('点「使用配对码配对设备」', 'Tap “Pair device with pairing code”'),
    t(
      '屏幕顶部弹出 Nova 的通知；没看到就下拉通知栏',
      'Nova’s notification pops up at the top of the screen; if not, swipe down to open the notification shade',
    ),
    t('点「填配对码」，输入 6 位数字', 'Tap “Enter code” and type the 6 digits'),
  ];
  String get manualToggle => t('通知没出来？在这里填', 'No notification? Enter it here');
  String get manualHint => t(
    '离开配对窗口它就会关掉。可以用分屏，一边看配对码一边在这里填。',
    'The pairing window closes when you leave it. Use split screen to see the code and type here at the same time.',
  );
  String get codeLabel => t('6 位配对码', '6-digit pairing code');
  String get portLabel => t(
    '配对窗口里「IP 地址和端口」冒号后面的数字',
    'The number after the colon in “IP address & port” in the pairing window',
  );
  String get portHint => t(
    'Nova 没找到配对窗口时才需要填',
    'Only needed if Nova can’t find the pairing window',
  );
  String get submit => t('配对', 'Pair');
  String get codeInvalid => t('要填 6 位数字', 'Enter 6 digits');
  String get portInvalid => t('冒号后面的数字不对', 'That number isn’t right');
  String get needNotifications => t(
    '配对码要在通知里填，先允许 Nova 发通知。',
    'The pairing code goes into a notification, so allow Nova’s notifications first.',
  );
  String get allowNotifications => t('允许通知', 'Allow notifications');
  String get appInfoHint => t(
    '打不开、选项是灰的？到「应用信息」里，点右上角 ⋮，选「允许受限制的设置」，再回来打开。',
    'Can’t turn it on, or it’s greyed out? Open “App info”, tap ⋮ at the top right, choose “Allow restricted settings”, then come back.',
  );
  String get openAppInfo => t('打开应用信息', 'Open App info');
  String get accessibilityOffNote => t(
    '不打开也行：Nova 会改在当前屏幕上操作 App，和以前一样，只是不能在虚拟屏上后台操作。',
    'You can leave it off: Nova then uses apps on your current screen as before, just not in the background on the virtual screen.',
  );

  ({String title, String body, String? action, String brief}) step(
    PhoneSetupStep step,
  ) => switch (step) {
    PhoneSetupStep.developer => (
      title: t('打开开发者选项', 'Turn on Developer options'),
      body: t(
        '打开手机设置里的「关于手机」，连续点「版本号」7 次，看到「你已处于开发者模式」的提示就好。有的手机「版本号」在「软件信息」里面。',
        'Open “About phone” in Settings and tap “Build number” 7 times until you see “You are now a developer”. On some phones “Build number” is under “Software information”.',
      ),
      action: t('打开开发者选项', 'Open Developer options'),
      brief: t(
        '在「关于手机」里连点「版本号」7 次',
        'Tap “Build number” 7 times in “About phone”',
      ),
    ),
    PhoneSetupStep.accessibility => (
      title: t('打开 Nova 的无障碍', 'Turn on Nova’s accessibility'),
      body: t(
        '在系统的「无障碍」设置里找到 Nova 并打开。Nova 用它读取虚拟屏上的内容并点按。如果系统提示「应用遮挡了权限请求」，先关掉其他 App 的悬浮窗或气泡，再试一次。',
        'Find Nova in your system’s “Accessibility” settings and turn it on. Nova uses it to read and tap the virtual screen. If the system says “An app is obscuring a permission request”, close other apps’ floating windows or bubbles and try again.',
      ),
      action: t('去无障碍设置', 'Open Accessibility settings'),
      brief: t('让 Nova 读取并点按虚拟屏', 'Lets Nova read and tap the virtual screen'),
    ),
    PhoneSetupStep.notifications => (
      title: t('允许通知', 'Allow notifications'),
      body: t(
        '配对码可以直接填在通知里，任务需要你时也会用通知提醒。',
        'The pairing code can be typed into a notification, and Nova alerts you with one when a task needs you.',
      ),
      action: t('允许通知', 'Allow notifications'),
      brief: t('用来填配对码和提醒你', 'For the pairing code and alerts'),
    ),
    PhoneSetupStep.wirelessDebugging => (
      title: t('打开无线调试', 'Turn on Wireless debugging'),
      body: t(
        '在「开发者选项」里找到「无线调试」并打开。问你是否允许时选「允许」，勾上「始终允许使用此网络」以后就不用再点。需要连着 Wi-Fi（不用能上网，连上就行）。',
        'In “Developer options”, find “Wireless debugging” and turn it on. When asked, choose “Allow” and tick “Always allow on this network” so you won’t be asked again. You need to be on Wi-Fi (internet access not required).',
      ),
      action: t('去无线调试', 'Open Wireless debugging'),
      brief: t('连着 Wi-Fi 就行，不需要能上网', 'Just be on Wi-Fi; no internet needed'),
    ),
    PhoneSetupStep.pairingCode => (
      title: t('用配对码配对', 'Pair with a code'),
      body: t(
        '点进「无线调试」，再点「使用配对码配对设备」，屏幕上会出现 6 位配对码。',
        'Open “Wireless debugging”, then tap “Pair device with pairing code”. A 6-digit code appears on screen.',
      ),
      action: t('去无线调试', 'Open Wireless debugging'),
      brief: t('填 6 位配对码，只要配一次', 'Enter the 6-digit code, only once'),
    ),
    PhoneSetupStep.connect => (
      title: t('自动连接', 'Connect automatically'),
      body: t(
        '配对好后，Nova 会自己连上并准备好，几秒钟就好。',
        'Once paired, Nova connects and gets ready by itself in a few seconds.',
      ),
      action: null,
      brief: t('配对好后自己连上', 'Connects by itself after pairing'),
    ),
  };

  String doneValue(PhoneSetupStep step) => switch (step) {
    PhoneSetupStep.pairingCode => paired,
    PhoneSetupStep.connect => t('已连接', 'Connected'),
    _ => t('已打开', 'On'),
  };

  // ---------- self-check ----------
  String get selfCheckHeader => t('自检', 'Self-check');
  String get selfCheckIntro => t(
    '大约 1 分钟。会临时建一块虚拟屏，在系统设置页上试一遍点按和打字，不会操作你的其他 App，不改设置，不联网。检查时请停留在这一页。',
    'About a minute. Nova briefly creates a virtual screen and tries tapping and typing on a system settings page. It doesn’t touch your other apps, change settings or use the internet. Stay on this page while it runs.',
  );
  String get selfCheckCopy => t('复制自检详情', 'Copy self-check details');
  String get selfCheckCopied => t('已复制', 'Copied');
  String get selfCheckStart => t('开始自检', 'Start self-check');
  String get selfCheckAgain => t('再查一次', 'Check again');
  String get selfCheckRunning => t('正在检查…', 'Checking…');
  String get selfCheckNeedsSetup =>
      t('先完成设置并连上助手，再来自检。', 'Finish setup and connect the helper first.');
  String get selfCheckRunActive => t(
    '有任务正在进行，等它结束后再自检。',
    'A task is running. Run the self-check after it finishes.',
  );
  String get selfCheckFailedToRun =>
      t('自检没能完成，请重试。', 'The self-check didn’t finish. Try again.');
  String selfCheckName(String id) => switch (id) {
    'helper' => t('内置助手', 'Built-in helper'),
    'create_display' => t('虚拟屏', 'Virtual screen'),
    'start_app' => t('打开 App', 'Open an app'),
    'read_tree' => t('读屏', 'Read the screen'),
    'tap' => t('点按', 'Tap'),
    'type' => t('打字', 'Type'),
    'back' => t('返回', 'Back'),
    'main_focus' => t('不打扰你的屏幕', 'Leaves your screen alone'),
    _ => id,
  };
  static const selfCheckOrder = [
    'helper',
    'create_display',
    'start_app',
    'read_tree',
    'tap',
    'type',
    'back',
    'main_focus',
  ];

  String selfCheckStatus(SelfCheckOutcome o) => switch (o) {
    SelfCheckOutcome.pass => t('通过', 'Passed'),
    SelfCheckOutcome.partial => t('部分可用', 'Partly works'),
    SelfCheckOutcome.fail => t('未通过', 'Failed'),
    SelfCheckOutcome.skipped => t('跳过', 'Skipped'),
  };

  String get _again => t('再查一次', 'check again');
  String get _stillFails => t(
    '还不行，就点下面的「复制自检详情」发给我们。',
    'If it still fails, tap “Copy self-check details” below and send it to us.',
  );

  /// What the user can do about a row; null when it passed.
  String? selfCheckAdvice(SelfCheckResult r) {
    final outcome = selfCheckOutcome(r);
    if (outcome == SelfCheckOutcome.pass) return null;
    return switch (r.detail) {
      'unsupported' => t(
        '系统低于安卓 12，手机操作用不了；聊天、网页照常能用。',
        'Below Android 12 phone control isn’t available; chat and web work as usual.',
      ),
      'not_running' || 'helper_unavailable' => t(
        '内置助手没在运行：先完成设置（必要时重新配对），再查一次。',
        'The helper isn’t running: finish setup (pair again if needed), then check again.',
      ),
      'accessibility_required' => t(
        '无障碍没开：在上面打开 Nova 的无障碍，再查一次。',
        'Accessibility is off: turn on Nova’s accessibility above, then check again.',
      ),
      'accessibility_flags_failed' || 'accessibility_unavailable' => t(
        '无障碍刚才断开或没能切换：把 Nova 的无障碍关掉再打开，然后再查一次。',
        'Accessibility disconnected or couldn’t switch: turn Nova’s accessibility off and on, then $_again.',
      ),
      'create_failed' || 'display_unavailable' => t(
        '虚拟屏建不起来或中途没了：点「重新配对」重新连接助手，再查一次。$_stillFails',
        'The virtual screen couldn’t be created or went away: tap “Pair again” to reconnect the helper, then $_again. $_stillFails',
      ),
      'app_in_use_on_main' => t(
        '检查用的系统设置页正开在你的屏幕上：按 Home 回到桌面，再查一次。',
        'The settings page used for the check is open on your screen: go to the home screen, then $_again.',
      ),
      'app_not_launchable' => t(
        '没能打开检查用的系统设置页：再查一次。$_stillFails',
        'The settings page used for the check wouldn’t open: $_again. $_stillFails',
      ),
      'shared_focus' => t(
        '虚拟屏没有自己的焦点，Nova 在后台操作时你屏幕上的输入焦点可能短暂丢失，不影响使用。',
        'The virtual screen has no focus of its own, so your keyboard focus may drop for a moment while Nova works. It doesn’t stop anything from working.',
      ),
      'unknown' => t(
        '读不出虚拟屏会不会抢走你的输入焦点，只是提醒；Nova 在后台操作时你的输入可能短暂被打断。',
        'Couldn’t tell whether the virtual screen can take your keyboard focus. Just a heads-up: your typing may drop for a moment while Nova works.',
      ),
      'not_on_display' => t(
        '页面没能开到虚拟屏上：再查一次。$_stillFails',
        'The page didn’t open on the virtual screen: $_again. $_stillFails',
      ),
      'empty_tree' => t(
        '读不到页面上的控件。把 Nova 的无障碍关掉再打开，再查一次。',
        'Couldn’t read anything on the page. Turn Nova’s accessibility off and on, then check again.',
      ),
      'no_frame' || 'black_frame' => t(
        '虚拟屏的画面是一片黑或没有画面：再查一次；还不行就重新配对。$_stillFails',
        'The virtual screen is black or has no picture: $_again; if it persists pair again. $_stillFails',
      ),
      'no_free_point' => t(
        '页面上没有找到可以安全点按的位置：再查一次。',
        'No safe spot to tap was found on the page: $_again.',
      ),
      'gesture_uncertain' => t(
        '系统没有确认点按是否生效，Nova 不会重复点未确认的操作：再查一次。',
        'The system didn’t confirm the tap. Nova never repeats an unconfirmed tap: $_again.',
      ),
      'tap_refused' => t(
        '点按被系统拒绝：把 Nova 的无障碍关掉再打开，再查一次。有的手机还要在开发者选项里允许「USB 调试（安全设置）」。$_stillFails',
        'The system refused the tap: turn Nova’s accessibility off and on, then $_again. Some phones also need “USB debugging (Security settings)” allowed in Developer options. $_stillFails',
      ),
      'injection_only' => t(
        '点按走了备用方式，可以用。',
        'The tap used a fallback and works.',
      ),
      'no_text_field' => t(
        '这次没找到可以打字的输入框，没有检查这一项。',
        'No text field was found to type into, so this wasn’t checked.',
      ),
      'text_not_set' => t(
        '打字没生效：把 Nova 的无障碍关掉再打开，再查一次。$_stillFails',
        'Typing didn’t work: turn Nova’s accessibility off and on, then $_again. $_stillFails',
      ),
      'injection_refused' || 'no_effect' => t(
        '返回键没生效：有的手机要在开发者选项里允许「USB 调试（安全设置）」；打开后再查一次。$_stillFails',
        'The back key didn’t work: some phones need “USB debugging (Security settings)” allowed in Developer options; allow it and $_again. $_stillFails',
      ),
      'not_run' => t(
        '前面的检查没通过，这一项没有检查。先解决上面的问题。',
        'An earlier check failed, so this one wasn’t run. Fix the problem above first.',
      ),
      _ =>
        outcome == SelfCheckOutcome.fail
            ? t(
                '这一项没通过：再查一次。$_stillFails',
                'This check failed: $_again. $_stillFails',
              )
            : null,
    };
  }

  /// A short text a user can paste into a report. Only fixed codes: no
  /// package names, screen text, tokens or provider output.
  String selfCheckReport(PhoneStatus s, List<SelfCheckResult> rows) {
    String safe(String? code) =>
        code == null || RegExp(r'^[a-z0-9_]{1,48}$').hasMatch(code)
        ? (code ?? '')
        : 'redacted';
    return [
      'Nova phone self-check',
      'android_api=${s.apiLevel} tier=${s.tier.name} helper=${s.helper.name} '
          'experimental=${s.experimental} experimental_ack=${s.experimentalAck} '
          'accessibility=${s.accessibility}',
      for (final r in rows)
        '${safe(r.id)}: ${r.ok ? 'ok' : 'FAIL'}'
            '${r.detail == null ? '' : ' (${safe(r.detail)})'}',
    ].join('\n');
  }
}

enum PhoneSetupStep {
  developer,
  accessibility,
  notifications,
  wirelessDebugging,
  pairingCode,
  connect,
}

enum SelfCheckOutcome { pass, partial, fail, skipped }

SelfCheckOutcome selfCheckOutcome(SelfCheckResult r) {
  if (r.detail == 'not_run' || r.detail == 'no_text_field') {
    return SelfCheckOutcome.skipped;
  }
  if (r.ok) {
    return r.detail == null ? SelfCheckOutcome.pass : SelfCheckOutcome.partial;
  }
  // The focus row is a heads-up, never a failure: its flags may be unreadable.
  return r.id == 'main_focus' &&
          (r.detail == 'shared_focus' || r.detail == 'unknown')
      ? SelfCheckOutcome.partial
      : SelfCheckOutcome.fail;
}
