import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideIonicAngular(), provideRouter([])],
    }).compileComponents();
  });

  it('should create the Ionic app shell', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('ion-app')).toBeTruthy();
    expect(compiled.querySelector('ion-router-outlet')).toBeTruthy();
  });
});
