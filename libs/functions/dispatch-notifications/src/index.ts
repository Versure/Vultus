// @vultus/functions/dispatch-notifications — public surface. The Firebase-free
// notification dispatch core for the availability Firestore trigger: the
// dispatcher factory + its port interfaces, plus the pure transition logic.
// The firebase-admin / FCM-bound adapters that implement these ports live in
// `apps/functions` — no Firebase import crosses this barrel.

export { createNotificationDispatcher } from './lib/dispatcher';
export type {
  NotificationDispatcher,
  DispatcherConfig,
  AvailabilityChange,
  DispatchSummary,
} from './lib/dispatcher';
export type {
  WatchlistStore,
  EpisodeStore,
  NotificationStore,
  FcmSender,
  TrackingUser,
  TrackedEpisode,
  FcmSendResult,
} from './lib/ports';
export {
  classifyFlatrateTransition,
  hasFlatrate,
  decideKinds,
} from './lib/transitions';
export type { FlatrateTransition } from './lib/transitions';
