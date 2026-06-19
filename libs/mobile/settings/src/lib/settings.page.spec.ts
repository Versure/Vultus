import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideIonicAngular()],
    }).compileComponents();
  });

  it('renders the settings placeholder page', async () => {
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('ion-content')).toBeTruthy();
    expect(compiled.querySelector('ion-title')?.textContent).toContain(
      'Settings',
    );
    expect(compiled.textContent).toContain('Settings will appear here.');
  });
});
