// Pure transition detection for one region. Diffs the prior `providers`
// (`prev`) against the freshly fetched `providers` (`next`), keyed by
// `providerId`:
//   - a providerId in `next` but not `prev`  → 'added'   (newly available)
//   - a providerId in `prev` but not `next`  → 'removed' (gone)
//   - a providerId in both                   → no transition (unchanged)
// No I/O, fully unit-testable. v1 keys on provider PRESENCE by providerId — a
// provider that stays present but changes bucket yields no transition.

import type { Region, WatchProvider } from '@vultus/shared/domain';
import type { ProviderTransition } from './types';

export function detectTransitions(
  region: Region,
  prev: WatchProvider[],
  next: WatchProvider[],
): ProviderTransition[] {
  const prevIds = new Set(prev.map((p) => p.providerId));
  const nextIds = new Set(next.map((p) => p.providerId));
  const transitions: ProviderTransition[] = [];

  for (const p of next) {
    if (!prevIds.has(p.providerId)) {
      transitions.push({
        region,
        providerId: p.providerId,
        name: p.name,
        type: p.type,
        kind: 'added',
      });
    }
  }

  for (const p of prev) {
    if (!nextIds.has(p.providerId)) {
      transitions.push({
        region,
        providerId: p.providerId,
        name: p.name,
        type: p.type,
        kind: 'removed',
      });
    }
  }

  return transitions;
}
