import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { describe, it, expect } from 'vitest';
import { VultusEmptyState } from './vultus-empty-state.component';

async function setup(inputs: {
  icon: string;
  title: string;
  subtitle?: string;
}) {
  await TestBed.configureTestingModule({
    imports: [VultusEmptyState],
    providers: [provideIonicAngular()],
  }).compileComponents();

  const fixture = TestBed.createComponent(VultusEmptyState);
  fixture.componentRef.setInput('icon', inputs.icon);
  fixture.componentRef.setInput('title', inputs.title);
  if (inputs.subtitle !== undefined) {
    fixture.componentRef.setInput('subtitle', inputs.subtitle);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('VultusEmptyState', () => {
  it('renders the icon bound to the icon input', async () => {
    const { el } = await setup({ icon: 'film-outline', title: 'Empty' });
    const icon = el.querySelector('.vultus-empty-state__icon');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('name')).toBe('film-outline');
  });

  it('renders the title text', async () => {
    const { el } = await setup({
      icon: 'film-outline',
      title: 'Your watchlist is empty',
    });
    expect(
      el.querySelector('.vultus-empty-state__title')?.textContent?.trim(),
    ).toBe('Your watchlist is empty');
  });

  it('does NOT render the subtitle when subtitle is empty (default)', async () => {
    const { el } = await setup({ icon: 'film-outline', title: 'Empty' });
    expect(el.querySelector('.vultus-empty-state__subtitle')).toBeNull();
  });

  it('renders the subtitle when subtitle is non-empty', async () => {
    const { el } = await setup({
      icon: 'film-outline',
      title: 'Empty',
      subtitle: 'Add something to get started.',
    });
    expect(
      el.querySelector('.vultus-empty-state__subtitle')?.textContent?.trim(),
    ).toBe('Add something to get started.');
  });
});
