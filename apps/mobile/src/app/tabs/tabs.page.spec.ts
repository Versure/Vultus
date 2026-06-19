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

  it('renders an ion-tabs with three tab buttons', async () => {
    const fixture = TestBed.createComponent(TabsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelector('ion-tabs')).toBeTruthy();
    const buttons = compiled.querySelectorAll('ion-tab-button');
    expect(buttons.length).toBe(3);
  });

  it('targets the watchlist / search / settings routes in order', async () => {
    const fixture = TestBed.createComponent(TabsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    const tabs = Array.from(compiled.querySelectorAll('ion-tab-button')).map(
      (b) => b.getAttribute('tab'),
    );
    expect(tabs).toEqual(['watchlist', 'search', 'settings']);
  });

  it('labels the tabs Watchlist / Search / Settings', async () => {
    const fixture = TestBed.createComponent(TabsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    const labels = Array.from(compiled.querySelectorAll('ion-label')).map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toEqual(['Watchlist', 'Search', 'Settings']);
  });
});
