package com.welverdiend.admin;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Welverdiend Admin: a thin WebView shell around the live admin dashboard.
 *
 * The dashboard itself is NOT bundled — it loads from the Cloud Run server
 * every time, so each deploy reaches the phone without a new APK. A new APK
 * is only needed when this file (the bridge, back button, file handling)
 * changes.
 *
 * The page talks to the app through window.WelverdiendApp (AppBridge below):
 * a WebView can't open blob: links, show the share sheet or keep the screen
 * on by itself, so admin-dashboard.html hands those jobs over when it sees
 * the bridge. In return the page exposes window.appBack() and
 * window.appRefresh() for the back button and pull-to-refresh.
 */
public class MainActivity extends Activity {

    static final String HOST = "welverdiend-booking-478269051372.europe-west1.run.app";
    static final String START_URL = "https://" + HOST + "/admin-dashboard.html";
    private static final int FILE_CHOOSER = 1;
    // Coming back to the app after this long refreshes the open tab.
    private static final long REFRESH_AFTER_MS = 60_000;

    private WebView web;
    private SwipeRefreshLayout swipe;
    private ValueCallback<Uri[]> fileCallback;
    private long pausedAt = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        clearSharedFiles();

        // Edge to edge (Android 15 enforces it): pad the content by the
        // status bar, navigation bar and keyboard so nothing hides under them.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(true);
        bars.setAppearanceLightNavigationBars(true);

        swipe = new SwipeRefreshLayout(this);
        swipe.setBackgroundColor(0xFFFAF8F3);
        swipe.setColorSchemeColors(0xFF4A4436);
        web = new WebView(this);
        swipe.addView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(swipe);

        ViewCompat.setOnApplyWindowInsetsListener(swipe, (v, insets) -> {
            Insets i = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the remembered admin token lives in localStorage
        s.setSupportMultipleWindows(false);    // window.open() navigates here, then shouldOverrideUrlLoading sends it out
        s.setUserAgentString(s.getUserAgentString() + " WelverdiendAdmin/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new AppBridge(), "WelverdiendApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("https".equals(u.getScheme()) && HOST.equals(u.getHost())) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                swipe.setRefreshing(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // Photo uploads on the Website tab use <input type="file">.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    toast("No app found to pick a file.");
                    return false;
                }
                return true;
            }
        });

        // A link the WebView can't show (e.g. a PDF) goes to the browser.
        web.setDownloadListener((url, userAgent, disposition, mimetype, length) -> openExternal(Uri.parse(url)));

        swipe.setOnChildScrollUpCallback((parent, child) -> web.getScrollY() > 0);
        swipe.setOnRefreshListener(() -> {
            web.evaluateJavascript("window.appRefresh ? window.appRefresh() : location.reload()", null);
            swipe.postDelayed(() -> swipe.setRefreshing(false), 1200);
        });

        if (savedInstanceState == null) web.loadUrl(START_URL);
        else web.restoreState(savedInstanceState);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        pausedAt = SystemClock.elapsedRealtime();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (pausedAt > 0 && SystemClock.elapsedRealtime() - pausedAt > REFRESH_AFTER_MS) {
            web.evaluateJavascript("window.appRefresh && window.appRefresh()", null);
        }
    }

    // Back closes whatever the page has open (live screen, pop-up, menu),
    // then returns to Bookings; only after that does the app go to the background.
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.appBack ? window.appBack() : false", value -> {
            if ("true".equals(value)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {       // several photos picked at once
                ClipData clip = data.getClipData();
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    private void showOffline() {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='font-family:sans-serif;background:#FAF8F3;color:#2B2A26;text-align:center;padding:60px 24px;'>"
                + "<h2 style='color:#4A4436;'>No connection</h2>"
                + "<p>The bookings dashboard needs the internet. Check your signal or Wi-Fi.</p>"
                + "<button onclick=\"location.href='" + START_URL + "'\" style='padding:12px 28px;border:0;border-radius:6px;"
                + "background:#4A4436;color:#fff;font-size:16px;'>Try again</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void openExternal(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme();
        Intent i;
        if (scheme.equals("tel")) i = new Intent(Intent.ACTION_DIAL, u);
        else if (scheme.equals("mailto")) i = new Intent(Intent.ACTION_SENDTO, u);
        else i = new Intent(Intent.ACTION_VIEW, u);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast("No app found to open this.");
        }
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    // ---- Files handed over by the page (invoices, proofs of payment)

    private File sharedDir() {
        File dir = new File(getCacheDir(), "shared");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    // Guest documents shouldn't pile up on the phone: cleared on every start.
    private void clearSharedFiles() {
        File[] old = sharedDir().listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    private Uri saveShared(String base64, String mime, String name) throws Exception {
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        String clean = name.replaceAll("[\\\\/:*?\"<>|]", "").trim();
        if (clean.isEmpty()) clean = "file";
        if (clean.length() > 80) clean = clean.substring(0, 80);
        if (ext != null && !clean.toLowerCase().endsWith("." + ext)) clean += "." + ext;
        File out = new File(sharedDir(), clean);
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(Base64.decode(base64, Base64.DEFAULT));
        }
        return FileProvider.getUriForFile(this, getPackageName() + ".files", out);
    }

    private boolean installed(String pkg) {
        try {
            getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** window.WelverdiendApp in admin-dashboard.html. Called on a background thread. */
    class AppBridge {
        @JavascriptInterface
        public void openFile(String base64, String mime, String name) {
            try {
                Uri uri = saveShared(base64, mime, name);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, mime);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(i);
            } catch (ActivityNotFoundException e) {
                toast("No app on this phone can open this file.");
            } catch (Exception e) {
                toast("Could not open the file.");
            }
        }

        // Straight into the guest's WhatsApp chat with the PDF attached. If
        // both WhatsApp and WhatsApp Business are installed, Android asks which.
        @JavascriptInterface
        public void shareToWhatsApp(String base64, String mime, String name, String text, String phone) {
            try {
                Uri uri = saveShared(base64, mime, name);
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType(mime);
                i.putExtra(Intent.EXTRA_STREAM, uri);
                i.putExtra(Intent.EXTRA_TEXT, text);
                if (phone != null && !phone.isEmpty()) i.putExtra("jid", phone + "@s.whatsapp.net");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                List<String> apps = new ArrayList<>();
                if (installed("com.whatsapp")) apps.add("com.whatsapp");
                if (installed("com.whatsapp.w4b")) apps.add("com.whatsapp.w4b");
                if (apps.size() == 1) {
                    i.setPackage(apps.get(0));
                    startActivity(i);
                } else {
                    startActivity(Intent.createChooser(i, "Send invoice"));
                }
            } catch (Exception e) {
                toast("Could not open WhatsApp.");
            }
        }

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Welverdiend", text));
            });
        }

        // The live calendar screen asks for this so a tablet/phone left on a stand stays on.
        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
