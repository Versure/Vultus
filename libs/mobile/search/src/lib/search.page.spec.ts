import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { SearchPage } from './search.page';

describe('SearchPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchPage],
      providers: [provideIonicAngular()],
    }).compileComponents();
  });

  it('renders the Search placeholder page', async () => {
    const fixture = TestBed.createComponent(SearchPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('ion-content')).toBeTruthy();
    expect(compiled.textContent).toContain('Search for movies and shows.');
  });
});
