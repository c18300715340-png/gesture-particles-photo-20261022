package com.gesturefield.photoparticles;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Size;
import android.webkit.WebView;

import androidx.activity.ComponentActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;

import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.core.Delegate;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer;
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizerResult;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class NativeGestureController {
    private final ComponentActivity activity;
    private final WebView webView;
    private final ExecutorService cameraExecutor = Executors.newSingleThreadExecutor();
    private ProcessCameraProvider cameraProvider;
    private GestureRecognizer recognizer;
    private volatile boolean requested;
    private boolean starting;
    private long lastInferenceAt;
    private long lastPreviewAt;

    NativeGestureController(ComponentActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    void start() {
        if (requested || starting) return;
        requested = true;
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, MainActivity.NATIVE_CAMERA_REQUEST);
            return;
        }
        startWithPermission();
    }

    void onCameraPermissionResult(boolean granted) {
        if (!requested) return;
        if (granted) startWithPermission();
        else reportError("请在手机设置中允许摄像头权限");
    }

    private void startWithPermission() {
        starting = true;
        cameraExecutor.execute(() -> {
            try {
                if (recognizer == null) {
                    BaseOptions baseOptions = BaseOptions.builder()
                            .setModelAssetPath("gesture_recognizer.task")
                            .setDelegate(Delegate.CPU)
                            .build();
                    GestureRecognizer.GestureRecognizerOptions options =
                            GestureRecognizer.GestureRecognizerOptions.builder()
                                    .setBaseOptions(baseOptions)
                                    .setRunningMode(RunningMode.VIDEO)
                                    .setNumHands(1)
                                    .setMinHandDetectionConfidence(0.55f)
                                    .setMinTrackingConfidence(0.5f)
                                    .build();
                    recognizer = GestureRecognizer.createFromOptions(activity, options);
                }
                if (!requested) return;
                activity.runOnUiThread(this::bindCamera);
            } catch (Throwable error) {
                reportError("原生手势模型初始化失败：" + describe(error));
            }
        });
    }

    private void bindCamera() {
        if (!requested) return;
        try {
            var future = ProcessCameraProvider.getInstance(activity);
            future.addListener(() -> {
                if (!requested) return;
                try {
                    cameraProvider = future.get();
                    ImageAnalysis analysis = new ImageAnalysis.Builder()
                            .setTargetResolution(new Size(640, 480))
                            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build();
                    analysis.setAnalyzer(cameraExecutor, this::processFrame);
                    cameraProvider.unbindAll();
                    cameraProvider.bindToLifecycle(activity, CameraSelector.DEFAULT_FRONT_CAMERA, analysis);
                    starting = false;
                    postJavascript("window.onNativeCameraReady && window.onNativeCameraReady()");
                } catch (Throwable error) {
                    reportError("打开前置摄像头失败：" + describe(error));
                }
            }, ContextCompat.getMainExecutor(activity));
        } catch (Throwable error) {
            reportError("连接摄像头失败：" + describe(error));
        }
    }

    private void processFrame(ImageProxy image) {
        if (!requested || recognizer == null) {
            image.close();
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastInferenceAt < 90) {
            image.close();
            return;
        }
        lastInferenceAt = now;
        boolean frameClosed = false;
        try {
            int rotation = image.getImageInfo().getRotationDegrees();
            Bitmap bitmap = Bitmap.createBitmap(image.getWidth(), image.getHeight(), Bitmap.Config.ARGB_8888);
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            buffer.rewind();
            bitmap.copyPixelsFromBuffer(buffer);
            image.close();
            frameClosed = true;
            Matrix matrix = new Matrix();
            matrix.postRotate(rotation);
            matrix.postScale(-1f, 1f);
            Bitmap upright = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            GestureRecognizerResult result = recognizer.recognizeForVideo(
                    new BitmapImageBuilder(upright).build(), now);
            JSONObject data = new JSONObject();
            if (!result.gestures().isEmpty() && !result.gestures().get(0).isEmpty()) {
                var gesture = result.gestures().get(0).get(0);
                data.put("name", gesture.categoryName());
                data.put("score", gesture.score());
            }
            if (!result.landmarks().isEmpty()) {
                JSONArray hand = new JSONArray();
                for (var point : result.landmarks().get(0)) {
                    hand.put(new JSONObject().put("x", point.x()).put("y", point.y()));
                }
                data.put("landmarks", hand);
            }
            if (now - lastPreviewAt >= 250) {
                lastPreviewAt = now;
                Bitmap small = Bitmap.createScaledBitmap(upright, 240, 180, true);
                ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.JPEG, 58, jpeg);
                data.put("preview", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
            }
            postJavascript("window.onNativeGesture && window.onNativeGesture(" + data + ")");
        } catch (Throwable error) {
            if (!frameClosed) image.close();
            reportError("手势识别运行失败：" + describe(error));
        }
    }

    void stop() {
        requested = false;
        starting = false;
        if (cameraProvider != null) cameraProvider.unbindAll();
    }

    void close() {
        stop();
        cameraExecutor.execute(() -> {
            if (recognizer != null) recognizer.close();
            recognizer = null;
        });
        cameraExecutor.shutdown();
    }

    private void reportError(String message) {
        activity.runOnUiThread(() -> {
            stop();
            postJavascript("window.onNativeCameraError && window.onNativeCameraError(" + JSONObject.quote(message) + ")");
        });
    }

    private void postJavascript(String script) {
        activity.runOnUiThread(() -> {
            if (requested) webView.evaluateJavascript(script, null);
            else if (script.contains("onNativeCameraError")) webView.evaluateJavascript(script, null);
        });
    }

    private static String describe(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }
}
