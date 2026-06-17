/**
 * Firebase Cloud Functions entry point for Vultus.
 *
 * This file is the deployable barrel: every exported symbol becomes a Cloud
 * Function. The handlers below are placeholders only — real sync and
 * notification logic arrives in the `functions/sync-titles` and
 * `functions/dispatch-notifications` slices (PLAN §6 items 9-14). Firebase
 * project wiring (`firebase.json`, emulators) is a separate spec (PLAN §6 item
 * 4) and is intentionally absent here.
 */
import { logger, setGlobalOptions } from 'firebase-functions';
import { onRequest } from 'firebase-functions/https';

// Keep deployments in a single region (free-tier friendly, PLAN §2).
setGlobalOptions({ region: 'europe-west1', maxInstances: 1 });

/**
 * Placeholder HTTP handler. Replaced by the rate-limited, shared-secret-guarded
 * sync endpoint in the `sync-titles` slice (PLAN §6 item 12).
 */
export const healthcheck = onRequest((_request, response) => {
  logger.info('Vultus functions healthcheck invoked');
  response.json({ status: 'ok', service: 'vultus-functions' });
});
