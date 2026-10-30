import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { PRESETS, PresetId } from '../../columns/presets';

export type StrikeCount = number | 'all';
export const STRIKE_COUNTS: readonly StrikeCount[] = [4, 6, 8, 16, 32, 40, 64, 'all'];
let nextId = 0;

@Component({
  selector: 'oc-view-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Column view">
        @for (p of presets; track p.id) {
          <button type="button" class="chip" [attr.data-testid]="'preset-' + p.id" [attr.aria-pressed]="p.id === presetId()" (click)="presetChange.emit(p.id)">
            {{ p.label }}
          </button>
        }
      </div>
      <div class="tools">
        @if (presetId() === 'custom' && !customEditorOpen()) {
          <button type="button" class="tool" (click)="editColumns.emit()">Edit columns</button>
        }
        <label class="lbl" [for]="selId">Strikes</label>
        <select class="tool" data-testid="strike-count" [id]="selId" (change)="onCount($any($event.target).value)">
          @for (c of counts; track c) {
            <option [value]="c" [selected]="c === strikeCount()">{{ c === 'all' ? 'All' : c }}</option>
          }
        </select>
        <button type="button" class="tool" title="Export visible rows as CSV" (click)="exportCsv.emit()">⬇ CSV</button>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; color: var(--ts-fg); background: var(--ts-bg); font-family: var(--ts-font); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 14px; border-bottom: 1px solid var(--ts-line); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      border: 1px solid var(--ts-line); background: var(--ts-bg); color: var(--ts-fg); border-radius: 999px;
      padding: 4px 12px; min-height: 32px; font: inherit; font-size: 13px; cursor: pointer;
    }
    .chip:hover { border-color: var(--ts-blue); }
    .chip[aria-pressed='true'] { background: var(--ts-blue); border-color: var(--ts-blue); color: var(--ts-on-accent); }
    .tools { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; align-items: center; }
    .lbl { font-size: 12px; color: var(--ts-muted); }
    button.tool {
      border: 1px solid var(--ts-outline); background: transparent; color: var(--ts-outline); border-radius: 4px;
      padding: 4px 10px; min-height: 32px; font: inherit; font-size: 13px; cursor: pointer;
    }
    select.tool {
      border: 1px solid var(--ts-input-border); background: var(--ts-input-bg); color: var(--ts-input-fg); border-radius: 4px;
      padding: 4px 8px; min-height: 32px; font: inherit; font-size: 13px; cursor: pointer;
    }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
  `,
})
export class ViewToolbarComponent {
  readonly presetId = input.required<PresetId | string>();
  readonly customEditorOpen = input(false);
  readonly strikeCount = input<StrikeCount>(16);

  readonly presetChange = output<PresetId>();
  readonly editColumns = output<void>();
  readonly strikeCountChange = output<StrikeCount>();
  readonly exportCsv = output<void>();

  protected readonly presets = PRESETS;
  protected readonly counts = STRIKE_COUNTS;
  protected readonly selId = `oc-strikes-${nextId++}`;

  protected onCount(v: string): void {
    this.strikeCountChange.emit(v === 'all' ? 'all' : Number(v));
  }
}
