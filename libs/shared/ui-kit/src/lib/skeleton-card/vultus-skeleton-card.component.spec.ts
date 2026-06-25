import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { describe, it, expect } from 'vitest';
import { VultusSkeletonCard } from './vultus-skeleton-card.component';

async function setup(count?: number) {
  await TestBed.configureTestingModule({
    imports: [VultusSkeletonCard],
    providers: [provideIonicAngular()],
  }).compileComponents();

  const fixture = TestBed.createComponent(VultusSkeletonCard);
  if (count !== undefined) {
    fixture.componentRef.setInput('count', count);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('VultusSkeletonCard', () => {
  it('renders 1 row by default (count=1)', async () => {
    const { el } = await setup();
    expect(el.querySelectorAll('.vultus-skeleton-card__row')).toHaveLength(1);
  });

  it('renders N rows for count=N', async () => {
    const { el } = await setup(3);
    expect(el.querySelectorAll('.vultus-skeleton-card__row')).toHaveLength(3);
  });

  it('each row contains poster, title, meta and badge skeleton-text', async () => {
    const { el } = await setup();
    const row = el.querySelector('.vultus-skeleton-card__row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.vultus-skeleton-card__poster')).not.toBeNull();
    expect(row?.querySelector('.vultus-skeleton-card__title')).not.toBeNull();
    expect(row?.querySelector('.vultus-skeleton-card__meta')).not.toBeNull();
    expect(row?.querySelector('.vultus-skeleton-card__badge')).not.toBeNull();
    expect(row?.querySelectorAll('ion-skeleton-text')).toHaveLength(4);
  });
});
