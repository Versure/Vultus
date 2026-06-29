import { test } from '@playwright/test';

/**
 * Spec 0041 — notification tap deep-links to title detail.
 *
 * Deferred (`test.fixme`): the flow depends on a real FCM message delivered to
 * a native device and the Capacitor PushNotifications runtime, neither of which
 * the Playwright web harness can drive. The handler logic itself is covered by
 * `apps/mobile/src/app/notification-handler.service.spec.ts`; the end-to-end
 * tap → navigate → mark-read path is verified MANUALLY on-device (see the spec).
 */
test.fixme('notification tap deep-links to title detail', // requires live FCM + native runtime; verify manually on-device.
() => {
  // Intentionally empty — fixme keeps this skipped until a native e2e
  // harness exists.
});
