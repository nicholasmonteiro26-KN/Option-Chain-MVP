import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Root shell: every page is a route (the option chain lives at /option-chain). */
@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {}
