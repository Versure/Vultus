import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { describe, it, expect } from 'vitest';
import { VultusSkeletonHero } from './vultus-skeleton-hero.component';

async function setup() {
  await TestBed.configureTestingModule({
    imports: [VultusSkeletonHero],
    providers: [provideIonicAngular()],
  }).compileComponents();

  const fixture = TestBed.createComponent(VultusSkeletonHero);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('VultusSkeletonHero', () => {
  it('renders the hero block', async () => {
    const { el } = await setup();
    expect(el.querySelector('.vultus-skeleton-hero__hero')).not.toBeNull();
  });

  it('renders 7 skeleton-text elements (hero + title + meta + 3 body + card)', async () => {
    const { el } = await setup();
    expect(el.querySelectorAll('ion-skeleton-text')).toHaveLength(7);
  });
});
