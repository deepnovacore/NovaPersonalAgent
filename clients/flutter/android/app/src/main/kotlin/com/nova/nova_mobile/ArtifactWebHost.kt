package com.nova.nova_mobile

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.Gravity
import android.text.TextUtils
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsResult
import android.webkit.JsPromptResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayInputStream
import java.util.UUID
import org.json.JSONObject

/** Local HTML/JS only. This WebView never receives a native JavaScript bridge. */
internal class ArtifactWebHost(private val activity: Activity, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "nova/artifacts/v1")
    private var foreground = false
    private var disposed = false
    private var probe: ArtifactPage? = null
    private var preview: Dialog? = null

    init {
        channel.setMethodCallHandler { call, reply ->
            // Flutter's default channel executor and all lifecycle hooks are UI-thread.
            check(Looper.myLooper() == Looper.getMainLooper())
            if (call.method != "open" && call.method != "inspect") {
                reply.error("unsupported_artifact_command", null, null)
                return@setMethodCallHandler
            }
            val input = call.arguments as? Map<*, *>
            val html = input?.get("html") as? String
            if (disposed || !foreground || activity.isFinishing || activity.isDestroyed || !ArtifactWebContract.validHtml(html)) {
                reply.error("artifact_unavailable", null, null)
                return@setMethodCallHandler
            }
            if (call.method == "inspect") {
                val script = input?.get("script") as? String
                if (probe != null || !ArtifactWebContract.validScript(script)) {
                    reply.error("artifact_test_busy_or_invalid", null, null)
                    return@setMethodCallHandler
                }
                inspect(html!!, script!!, reply)
            } else {
                open(html!!, (input?.get("title") as? String ?: "作品").take(200), reply)
            }
        }
    }

    fun resume() { if (!disposed) foreground = true }

    fun pause() {
        foreground = false
        probe?.finish(ArtifactWebContract.failure("preview_process_stopped"))
        preview?.dismiss()
        preview = null
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        pause()
        channel.setMethodCallHandler(null)
    }

    private fun inspect(html: String, script: String, reply: MethodChannel.Result) {
        var page: ArtifactPage? = null
        try {
            val created = ArtifactPage(activity, html)
            page = created
            probe = created
            val parent = activity.findViewById<ViewGroup>(android.R.id.content)
            // Attach behind Flutter to give DOM layout a real viewport without
            // exposing an invisible input/accessibility surface to the user.
            created.web.alpha = 0f
            created.web.isEnabled = false
            created.web.isFocusable = false
            created.web.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            parent.addView(created.web, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            created.inspect(script) { value ->
                if (probe === created) probe = null
                created.destroy()
                reply.success(value)
            }
        } catch (_: Exception) {
            if (probe === page) probe = null
            page?.destroy()
            reply.error("artifact_preview_failed", null, null)
        }
    }

    @Suppress("DEPRECATION")
    private fun open(html: String, title: String, reply: MethodChannel.Result) {
        var page: ArtifactPage? = null
        var dialog: Dialog? = null
        try {
            preview?.dismiss()
            val created = ArtifactPage(activity, html)
            page = created
            val shown = Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar)
            dialog = shown
            val themed = shown.context
            val density = themed.resources.displayMetrics.density
            fun dp(value: Int) = (value * density + 0.5f).toInt()
            val column = LinearLayout(themed).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.WHITE)
            }
            column.setOnApplyWindowInsetsListener { view, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                    view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                    WindowInsets.CONSUMED
                } else {
                    val cutout = if (Build.VERSION.SDK_INT >= 28) insets.displayCutout else null
                    view.setPadding(
                        maxOf(insets.systemWindowInsetLeft, cutout?.safeInsetLeft ?: 0),
                        maxOf(insets.systemWindowInsetTop, cutout?.safeInsetTop ?: 0),
                        maxOf(insets.systemWindowInsetRight, cutout?.safeInsetRight ?: 0),
                        maxOf(insets.systemWindowInsetBottom, cutout?.safeInsetBottom ?: 0)
                    )
                    insets.consumeSystemWindowInsets()
                }
            }
            val toolbar = LinearLayout(themed).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), 0, dp(8), 0)
                minimumHeight = dp(56)
            }
            fun action(label: String, click: () -> Unit) = Button(themed, null, android.R.attr.borderlessButtonStyle).apply {
                text = label
                isAllCaps = false
                textSize = 14f
                setTextColor(Color.rgb(35, 91, 65))
                minimumHeight = dp(48)
                setOnClickListener { click() }
            }
            toolbar.addView(action("关闭") { shown.dismiss() })
            toolbar.addView(TextView(themed).apply {
                text = title
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
                textSize = 16f
                setTextColor(Color.BLACK)
                setPadding(dp(8), 0, dp(8), 0)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            toolbar.addView(action("重新加载") { created.load() })
            column.addView(toolbar)
            column.addView(created.web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            shown.setContentView(column)
            shown.setOnDismissListener {
                if (preview === shown) preview = null
                created.destroy()
            }
            shown.show()
            shown.window?.apply {
                setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
                clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS or WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION)
                statusBarColor = Color.WHITE
                navigationBarColor = Color.WHITE
                if (Build.VERSION.SDK_INT >= 30) {
                    setDecorFitsSystemWindows(false)
                    val appearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                    insetsController?.setSystemBarsAppearance(appearance, appearance)
                } else {
                    decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                        View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                        (if (Build.VERSION.SDK_INT >= 26) View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0)
                    // API24–25 cannot draw dark navigation icons on white.
                    if (Build.VERSION.SDK_INT < 26) navigationBarColor = Color.BLACK
                }
            }
            column.requestApplyInsets()
            preview = shown
            created.load()
            reply.success(mapOf("opened" to true))
        } catch (_: Exception) {
            dialog?.dismiss()
            page?.destroy()
            reply.error("artifact_preview_failed", null, null)
        }
    }
}

@Suppress("DEPRECATION")
private class ArtifactPage(activity: Activity, private val html: String) {
    val web = WebView(activity)
    private val readyToken = UUID.randomUUID().toString()
    private val documentUrl = "https://${UUID.randomUUID()}.invalid/index.html"
    private val documentBytes = ArtifactWebContract.document(html, readyToken).toByteArray(Charsets.UTF_8)
    private val handler = Handler(Looper.getMainLooper())
    private var destroyed = false
    private var evaluating = false
    private var script: String? = null
    private var completion: ((Map<String, Any?>) -> Unit)? = null
    private val timeout = Runnable { finish(ArtifactWebContract.failure("preview_timeout")) }
    private val evaluate = Runnable {
        val body = script
        if (!destroyed && completion != null && body != null) {
            script = null
            try {
                web.evaluateJavascript("document.readyState==='complete' && window.__novaArtifactToken===${JSONObject.quote(readyToken)}") { ready ->
                    if (!destroyed && completion != null) {
                        if (ready != "true") {
                            finish(ArtifactWebContract.failure("artifact_document_not_ready"))
                        } else {
                            web.evaluateJavascript(ArtifactWebContract.inspectionScript(body)) { raw ->
                                if (!destroyed) finish(ArtifactWebContract.decodeResult(raw))
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                finish(ArtifactWebContract.failure("javascript_evaluation_failed", loaded = true))
            }
        }
    }

    init {
        web.settings.apply {
            javaScriptEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            blockNetworkLoads = true
            blockNetworkImage = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            domStorageEnabled = false
            databaseEnabled = false
            saveFormData = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.setDownloadListener { _, _, _, _, _ -> /* no downloads */ }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage?): Boolean = true
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean = false
            override fun onPermissionRequest(request: PermissionRequest?) { request?.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) { callback?.invoke(origin, false, false) }
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean { callback?.onReceiveValue(null); return true }
            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean { result?.cancel(); return true }
            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean { result?.cancel(); return true }
            override fun onJsPrompt(view: WebView?, url: String?, message: String?, defaultValue: String?, result: JsPromptResult?): Boolean { result?.cancel(); return true }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = !ArtifactWebContract.permitsNavigation(request?.url?.toString(), documentUrl)
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = !ArtifactWebContract.permitsNavigation(url, documentUrl)
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse =
                if (request?.isForMainFrame == true && request.url.toString() == documentUrl) document() else blocked()
            override fun shouldInterceptRequest(view: WebView?, url: String?): WebResourceResponse =
                if (url == documentUrl) document() else blocked()
            override fun onPageFinished(view: WebView?, url: String?) {
                if (!destroyed && !evaluating && completion != null && url == documentUrl) {
                    evaluating = true
                    handler.postDelayed(evaluate, ArtifactWebContract.settleMillis)
                }
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) finish(ArtifactWebContract.failure("preview_navigation_failed"))
            }
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                if (completion != null) finish(ArtifactWebContract.failure("preview_process_stopped")) else destroy()
                return true
            }
        }
        if (Build.VERSION.SDK_INT >= 26) {
            web.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
    }

    fun load() {
        if (!destroyed) web.loadUrl(documentUrl)
    }

    fun inspect(body: String, callback: (Map<String, Any?>) -> Unit) {
        script = body
        completion = callback
        handler.postDelayed(timeout, ArtifactWebContract.timeoutMillis)
        load()
    }

    fun finish(value: Map<String, Any?>) {
        val callback = completion ?: return
        completion = null
        handler.removeCallbacks(timeout)
        handler.removeCallbacks(evaluate)
        runCatching { web.stopLoading() }
        callback(value)
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        completion = null
        script = null
        handler.removeCallbacks(timeout)
        handler.removeCallbacks(evaluate)
        (web.parent as? ViewGroup)?.removeView(web)
        runCatching { web.stopLoading() }
        runCatching { web.onPause() }
        web.webChromeClient = null
        web.webViewClient = WebViewClient()
        runCatching { web.destroy() }
    }

    // This exact main document is returned before networking. Every other
    // request remains blocked, and WebSettings also prohibits network loads.
    // A response CSP supports sandbox (unlike a meta CSP), making the page an
    // opaque origin with no cookie/storage access even at this synthetic URL.
    private fun document() = WebResourceResponse("text/html", "utf-8", 200, "OK", mapOf(
        "Content-Security-Policy" to "${ArtifactWebContract.contentPolicy}; sandbox allow-scripts",
        "Cache-Control" to "no-store",
        "X-Content-Type-Options" to "nosniff"
    ), ByteArrayInputStream(documentBytes))

    companion object {
        private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
