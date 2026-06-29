import { NotificationsService } from './notifications.service';

/**
 * Real providers for the notifications inbox. The page declares
 * `providers: [...NOTIFICATIONS_PROVIDERS]`; under `--configuration=mock` a
 * build-time `fileReplacements` entry swaps this for
 * `notifications.providers.mock.ts` (mirrors the settings slice pattern).
 */
export const NOTIFICATIONS_PROVIDERS = [NotificationsService] as const;
