import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IonButton, provideIonicAngular } from '@ionic/angular/standalone';
import { describe, it, expect } from 'vitest';
import { VultusAppHeader } from './vultus-app-header.component';

/** Test host that projects a trailing button into the shared header. */
@Component({
  imports: [VultusAppHeader, IonButton],
  template:
    '<vultus-app-header><ion-button aria-label="Account"></ion-button></vultus-app-header>',
})
class HostComponent {}

async function renderComponent() {
  await TestBed.configureTestingModule({
    imports: [VultusAppHeader],
    providers: [provideIonicAngular()],
  }).compileComponents();

  const fixture = TestBed.createComponent(VultusAppHeader);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

async function renderHost() {
  await TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideIonicAngular()],
  }).compileComponents();

  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('VultusAppHeader', () => {
  it('renders the brand mark with the film-outline icon and exact "Vultus" text', async () => {
    const { el } = await renderComponent();

    const brandMark = el.querySelector('.brand-mark');
    expect(brandMark).not.toBeNull();

    const brandIcon = brandMark?.querySelector(
      'ion-icon[name="film-outline"].brand-icon',
    );
    expect(brandIcon).not.toBeNull();

    // Assert on the brand-mark's own text node (the token after the icon),
    // stripping only the surrounding source-indentation whitespace — NOT a
    // whole-subtree whitespace-normalize that would mask a stray-space defect.
    const textNodes = Array.from(brandMark?.childNodes ?? []).filter(
      (n) => n.nodeType === Node.TEXT_NODE,
    );
    const brandText = textNodes
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    expect(brandText).toBe('Vultus');
  });

  it('projects trailing content into the toolbar end slot', async () => {
    const { el } = await renderHost();

    const projected = el.querySelector(
      'ion-buttons[slot="end"] ion-button[aria-label="Account"]',
    );
    expect(projected).not.toBeNull();
  });

  it('does not declare a min-height in its template', async () => {
    const { el } = await renderComponent();
    expect(el.innerHTML).not.toContain('min-height');
  });
});
