import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { describe, it, expect, vi } from 'vitest';
import { VultusErrorState } from './vultus-error-state.component';

async function setup(inputs?: { message?: string }) {
  await TestBed.configureTestingModule({
    imports: [VultusErrorState],
    providers: [provideIonicAngular()],
  }).compileComponents();

  const fixture = TestBed.createComponent(VultusErrorState);
  if (inputs?.message !== undefined) {
    fixture.componentRef.setInput('message', inputs.message);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    el: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance,
  };
}

describe('VultusErrorState', () => {
  it('renders the default message', async () => {
    const { el } = await setup();
    expect(
      el.querySelector('.vultus-error-state__message')?.textContent?.trim(),
    ).toBe('Something went wrong');
  });

  it('renders a custom message when message input is set', async () => {
    const { el } = await setup({ message: "Couldn't load your watchlist." });
    expect(
      el.querySelector('.vultus-error-state__message')?.textContent?.trim(),
    ).toBe("Couldn't load your watchlist.");
  });

  it('emits retry exactly once when ion-button is clicked', async () => {
    const { el, component } = await setup();
    const retrySpy = vi.fn();
    component.retry.subscribe(retrySpy);
    const button = el.querySelector('ion-button');
    expect(button).not.toBeNull();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });
});
