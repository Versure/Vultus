import { SettingsService } from './settings.service';
import { SyncStatusService } from './sync-status.service';

export const SETTINGS_PROVIDERS = [SettingsService, SyncStatusService] as const;
