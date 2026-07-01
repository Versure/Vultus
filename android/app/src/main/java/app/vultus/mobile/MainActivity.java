package app.vultus.mobile;

import android.os.Bundle;

// TODO(0055): DIAGNOSTIC — remove before merge (extra imports for VultusCutoutDiag)
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;
import android.util.TypedValue;
import android.view.DisplayCutout;
import android.view.WindowManager;
// END TODO(0055) DIAGNOSTIC imports

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    hideSystemBars();

    // TODO(0055): DIAGNOSTIC — remove before merge.
    // Temporary instrumentation (spec 0055) to capture, on a real notched device,
    // the actually-resolved running window theme, the resolved
    // layoutInDisplayCutoutMode, and the real WindowInsets display-cutout bounds.
    // Purely additive: does NOT consume insets, does NOT call
    // setDecorFitsSystemViews, does NOT alter hideSystemBars() (0039).
    logResolvedThemeDiag("onCreate");
    logCutoutModeDiag("onCreate");
    installCutoutInsetsDiag();
    // END TODO(0055) DIAGNOSTIC block (onCreate).
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) {
      // Re-hide after a dialog / keyboard / recents has stolen and returned focus.
      hideSystemBars();

      // TODO(0055): DIAGNOSTIC — remove before merge.
      // The cutout mode may differ once the splash theme has swapped, so re-log
      // it after the window has focus. Purely additive logging.
      logResolvedThemeDiag("onWindowFocusChanged");
      logCutoutModeDiag("onWindowFocusChanged");
      // END TODO(0055) DIAGNOSTIC block (onWindowFocusChanged).
    }
  }

  private void hideSystemBars() {
    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.hide(WindowInsetsCompat.Type.systemBars());
    controller.setSystemBarsBehavior(
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
  }

  // TODO(0055): DIAGNOSTIC — remove before merge.
  // ==========================================================================
  // VultusCutoutDiag — temporary diagnostic helpers (spec 0055).
  // These log only; they change no window behavior. Remove the entire block
  // (and the DIAGNOSTIC imports + the call sites above) in Step 2.
  // ==========================================================================
  private static final String DIAG_TAG = "VultusCutoutDiag";

  /**
   * Logs which theme is actually resolved on the running activity window so we
   * can distinguish AppTheme.NoActionBar vs AppTheme.NoActionBarLaunch vs the
   * plain AppTheme. Works on all API levels (>= minSdk 24).
   */
  private void logResolvedThemeDiag(String phase) {
    try {
      // Resolve the running theme resource id/name. getThemeResId() is hidden
      // API, so read it reflectively; fall back to just logging the resolved
      // cutout attribute if reflection is unavailable.
      String themeName = "<unknown>";
      int themeResId = 0;
      try {
        java.lang.reflect.Method m =
            android.content.Context.class.getMethod("getThemeResId");
        Object res = m.invoke(this);
        if (res instanceof Integer) {
          themeResId = (Integer) res;
          if (themeResId != 0) {
            themeName = getResources().getResourceName(themeResId);
          }
        }
      } catch (Throwable reflectErr) {
        Log.w(DIAG_TAG, "[" + phase + "] getThemeResId() reflection unavailable: "
            + reflectErr);
      }

      // Resolve whether the running theme carries windowLayoutInDisplayCutoutMode.
      // This attribute is API-28+; guard the read.
      String cutoutAttr = "<n/a: API<28>";
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        TypedValue tv = new TypedValue();
        boolean found =
            getTheme().resolveAttribute(
                android.R.attr.windowLayoutInDisplayCutoutMode, tv, true);
        if (found) {
          cutoutAttr = "resolved data=" + tv.data + " (type=" + tv.type + ")";
        } else {
          cutoutAttr = "<attribute not present in running theme>";
        }
      }

      Log.d(DIAG_TAG, "[" + phase + "] running theme: name=" + themeName
          + " resId=0x" + Integer.toHexString(themeResId)
          + " | theme.windowLayoutInDisplayCutoutMode=" + cutoutAttr);
    } catch (Throwable t) {
      Log.e(DIAG_TAG, "[" + phase + "] logResolvedThemeDiag failed", t);
    }
  }

  /**
   * Logs the window's resolved layoutInDisplayCutoutMode. The field is API-28+;
   * guard the read so the diagnostic build does not crash on API < 28.
   */
  private void logCutoutModeDiag(String phase) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        WindowManager.LayoutParams attrs = getWindow().getAttributes();
        int mode = attrs.layoutInDisplayCutoutMode;
        Log.d(DIAG_TAG, "[" + phase + "] window.layoutInDisplayCutoutMode=" + mode
            + " (" + cutoutModeName(mode) + ")");
      } else {
        Log.d(DIAG_TAG, "[" + phase
            + "] window.layoutInDisplayCutoutMode <n/a: API<28>");
      }
    } catch (Throwable t) {
      Log.e(DIAG_TAG, "[" + phase + "] logCutoutModeDiag failed", t);
    }
  }

  private static String cutoutModeName(int mode) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      return "unknown";
    }
    switch (mode) {
      case WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT:
        return "DEFAULT";
      case WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES:
        return "SHORT_EDGES";
      case WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER:
        return "NEVER";
      default:
        // ALWAYS is API-30+; avoid referencing the constant to stay compileSdk-safe.
        return "OTHER(" + mode + ")";
    }
  }

  /**
   * Attaches an apply-insets listener on the decor view (via the AndroidX compat
   * API, already on the classpath) that logs the real display-cutout bounds/insets
   * once WindowInsets are available. Returns the insets UNCONSUMED so inset
   * propagation is unchanged.
   */
  private void installCutoutInsetsDiag() {
    try {
      ViewCompat.setOnApplyWindowInsetsListener(
          getWindow().getDecorView(),
          (view, insets) -> {
            try {
              androidx.core.view.DisplayCutoutCompat cutout = insets.getDisplayCutout();
              if (cutout == null) {
                Log.d(DIAG_TAG, "[insets] WindowInsetsCompat.getDisplayCutout()=null");
              } else {
                StringBuilder rects = new StringBuilder();
                // getBoundingRects() is API-28+; guard the framework-cutout read.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                  DisplayCutout framework = view.getRootWindowInsets() != null
                      ? view.getRootWindowInsets().getDisplayCutout()
                      : null;
                  if (framework != null) {
                    for (Rect r : framework.getBoundingRects()) {
                      rects.append(r.toShortString()).append(' ');
                    }
                  }
                }
                Log.d(DIAG_TAG, "[insets] getDisplayCutout()=non-null"
                    + " safeInsets(l/t/r/b)=" + cutout.getSafeInsetLeft()
                    + "/" + cutout.getSafeInsetTop()
                    + "/" + cutout.getSafeInsetRight()
                    + "/" + cutout.getSafeInsetBottom()
                    + " boundingRects=[" + rects.toString().trim() + "]");
              }

              // Also log the systemBars + displayCutout compat insets for context.
              androidx.core.graphics.Insets cutoutInsets =
                  insets.getInsets(WindowInsetsCompat.Type.displayCutout());
              Log.d(DIAG_TAG, "[insets] displayCutout inset type (l/t/r/b)="
                  + cutoutInsets.left + "/" + cutoutInsets.top
                  + "/" + cutoutInsets.right + "/" + cutoutInsets.bottom);
            } catch (Throwable t) {
              Log.e(DIAG_TAG, "[insets] logging failed", t);
            }
            // Return UNCONSUMED — do not alter inset propagation.
            return insets;
          });
      // Ensure the listener fires with current insets.
      ViewCompat.requestApplyInsets(getWindow().getDecorView());
    } catch (Throwable t) {
      Log.e(DIAG_TAG, "[insets] installCutoutInsetsDiag failed", t);
    }
  }
  // END TODO(0055) DIAGNOSTIC block (VultusCutoutDiag helpers).
}
