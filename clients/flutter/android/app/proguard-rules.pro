# app_process loads the installed base APK by class name, outside Android component discovery.
-keep class com.nova.nova_mobile.phone.shell.HelperMain { public static void main(java.lang.String[]); }
-keep class com.nova.nova_mobile.phone.shell.HelperProcess { *; }
-keep class com.nova.nova_mobile.phone.shell.HelperProcess$* { *; }
-keep class com.nova.nova_mobile.phone.shell.NovaShellService { *; }
-keep class com.nova.nova_mobile.phone.shell.INovaShell { *; }
-keep class com.nova.nova_mobile.phone.shell.INovaShell$* { *; }
-keep class com.nova.nova_mobile.phone.shell.ShellContext { *; }
# Platform methods are accessed by their platform names; no app reflection targets beyond these.
