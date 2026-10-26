package com.gesturefield.photoparticles;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.util.Arrays;

public final class MainActivity extends ComponentActivity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int CAMERA_REQUEST = 1001;
    private static final int IMAGE_REQUEST = 1002;
    static final int NATIVE_CAMERA_REQUEST = 1003;

    private WebView webView;
    private PermissionRequest pendingCameraRequest;
    private ValueCallback<Uri[]> pendingFileChooser;
    private NativeGestureController nativeGestureController;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(8, 17, 26));
        getWindow().setNavigationBarColor(Color.rgb(8, 17, 26));

        WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(this);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", path -> {
                    WebResourceResponse response = assets.handle(path);
                    if (response == null) return null;
                    if (path.endsWith(".mjs") || path.endsWith(".js")) response.setMimeType("text/javascript");
                    else if (path.endsWith(".wasm")) response.setMimeType("application/wasm");
                    else if (path.endsWith(".task")) response.setMimeType("application/octet-stream");
                    else if (path.endsWith(".aac")) response.setMimeType("audio/aac");
                    return response;
                })
                .build();

        webView = new WebView(this);
        nativeGestureController = new NativeGestureController(this, webView);
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface public void start() {
                runOnUiThread(() -> nativeGestureController.start());
            }
            @JavascriptInterface public void stop() {
                runOnUiThread(() -> nativeGestureController.stop());
            }
        }, "AndroidGesture");
        webView.setBackgroundColor(Color.rgb(8, 13, 22));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !"https".equals(uri.getScheme()) || !APP_HOST.equals(uri.getHost());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleCameraRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCameraRequest == request) pendingCameraRequest = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择照片"), IMAGE_REQUEST);
                    return true;
                } catch (RuntimeException error) {
                    pendingFileChooser = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "无法打开图片选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        setContentView(webView);
        webView.loadUrl(START_URL);
    }

    private void handleCameraRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        boolean localOrigin = "https".equals(origin.getScheme()) && APP_HOST.equals(origin.getHost());
        boolean videoOnly = Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                && request.getResources().length == 1;
        if (!localOrigin || !videoOnly) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingCameraRequest = request;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_REQUEST && pendingCameraRequest != null) {
            PermissionRequest request = pendingCameraRequest;
            pendingCameraRequest = null;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                request.deny();
            }
        }
        if (requestCode == NATIVE_CAMERA_REQUEST) {
            nativeGestureController.onCameraPermissionResult(grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == IMAGE_REQUEST && pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingFileChooser = null;
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (nativeGestureController != null) nativeGestureController.close();
        if (pendingCameraRequest != null) pendingCameraRequest.deny();
        if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
