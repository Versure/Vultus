import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { WatchlistPage } from './watchlist.page';

describe('WatchlistPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WatchlistPage],
      providers: [provideIonicAngular()],
    }).compileComponents();
  });

  it('renders the watchlist placeholder content', async () => {
    const fixture = TestBed.createComponent(WatchlistPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('ion-content')).toBeTruthy();
    expect(compiled.textContent).toContain('Your watchlist will appear here.');
  });
});
