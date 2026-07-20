import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { TabsPage } from './tabs.page';

describe('TabsPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TabsPage],
      providers: [provideIonicAngular(), provideRouter([])],
    }).compileComponents();
  });

  it('renders an ion-tabs with four tab buttons', async () => {
    const fixture = TestBed.createComponent(TabsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelector('ion-tabs')).toBeTruthy();
    const buttons = compiled.querySelectorAll('ion-tab-button');
    expect(buttons.length).toBe(4);
  });

  it('targets the today / watchlist / search / settings routes in order', async () => {
    const fixture = TestBed.createComponent(TabsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    const tabs = Array.from(compiled.querySelectorAll('ion-tab-button')).map(
      (b) => b.getAttribute('tab'),
    );
    expect(tabs).toEqual(['today', 'watchlist', 'search', 'settings']);
  });

  it('labels the tabs Today / Watchlist / Search / Settings', async () => {
    const fixture = TestBed.createComponent(TabsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    const labels = Array.from(compiled.querySelectorAll('ion-label')).map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toEqual(['Today', 'Watchlist', 'Search', 'Settings']);
  });
});
