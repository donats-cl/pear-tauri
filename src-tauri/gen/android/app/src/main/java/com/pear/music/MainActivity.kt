package com.pear.music

import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

// Тот же User-Agent, что MOBILE_USER_AGENT в lib.rs: YouTube Music отдаёт
// десктопную версию, на которую рассчитаны наши доработки.
private const val DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

// Google пишет «браузер небезопасен», когда WebView выдаёт себя за десктопный
// Chrome. Поэтому на страницах входа WebView представляется честно (так входят
// и сторонние клиенты YouTube Music), а вернувшись на music.youtube.com,
// снова включает десктопный User-Agent. Скрипт выполняется до кода страницы
// и перезагружает её, если User-Agent не тот.
private const val UA_SWITCH_SCRIPT = """
(function () {
  if (window.top !== window || !window.PearAndroid) return;
  var desktop = navigator.userAgent.indexOf('Windows NT') >= 0;
  var host = location.hostname;
  if (host === 'accounts.google.com' && desktop) PearAndroid.switchUa(false, location.href);
  else if (host === 'music.youtube.com' && !desktop) PearAndroid.switchUa(true, location.href);
})();
"""

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    webView.addJavascriptInterface(UaSwitcher(webView), "PearAndroid")
    WebViewCompat.addDocumentStartJavaScript(webView, UA_SWITCH_SCRIPT, setOf("*"))
  }

  private class UaSwitcher(private val webView: WebView) {
    @JavascriptInterface
    fun switchUa(desktop: Boolean, url: String) {
      val host = Uri.parse(url).host
      if (host != "accounts.google.com" && host != "music.youtube.com") return
      webView.post {
        val settings = webView.settings
        val ua = if (desktop) DESKTOP_UA else WebSettings.getDefaultUserAgent(webView.context)
        if (settings.userAgentString == ua) return@post
        settings.userAgentString = ua
        webView.stopLoading()
        webView.loadUrl(url)
      }
    }
  }
}
