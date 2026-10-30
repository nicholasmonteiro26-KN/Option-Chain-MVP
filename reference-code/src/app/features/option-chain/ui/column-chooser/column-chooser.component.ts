import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { COLUMNS, ColumnDef } from '../../columns/column-registry';
import { CUSTOM_LIMIT_MESSAGE, CustomPreset, MAX_CUSTOM_PRESETS } from '../../data-access/prefs.store';

type Mode = 'mirrored' | 'strike';
export interface SavePresetEvent { name: string; mode: Mode; columns: string[] }
export interface RenamePresetEvent { id: string; name: string }


@Component({
  selector: 'oc-column-chooser',
  imports: [CdkDropList, CdkDrag, CdkDragHandle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="custom" aria-label="Custom columns">
      <div class="row">
        <b>Choose columns for your Custom view</b>
        <span class="mode" role="group" aria-label="Column mode">
          <button type="button" class="tool" [attr.aria-pressed]="mode() === 'mirrored'" (click)="setMode('mirrored')">Side columns</button>
          <button type="button" class="tool" [attr.aria-pressed]="mode() === 'strike'" (click)="setMode('strike')">Strike columns</button>
        </span>
      </div>
      <p class="help">The put side mirrors the call side. Saved in this browser.</p>

      <ul class="chosen" cdkDropList (cdkDropListDropped)="drop($event)" aria-label="Selected columns, in order">
        @for (c of chosen(); track c.id; let i = $index; let first = $first; let last = $last) {
          <li cdkDrag class="item">
            <span cdkDragHandle class="grip" aria-hidden="true">⋮⋮</span>
            <label>
              <input type="checkbox" [value]="c.id" checked (change)="toggle(c.id)" />
              {{ c.label }}
            </label>
            <button type="button" class="mv" [attr.aria-label]="'Move ' + c.label + ' up'" [disabled]="first" (click)="move(i, -1)">↑</button>
            <button type="button" class="mv" [attr.aria-label]="'Move ' + c.label + ' down'" [disabled]="last" (click)="move(i, 1)">↓</button>
          </li>
        }
      </ul>
      <div class="grid">
        @for (c of unchosen(); track c.id) {
          <label>
            <input type="checkbox" [value]="c.id" (change)="toggle(c.id)" />
            {{ c.label }}
          </label>
        }
      </div>

      <div class="saved">
        <b>Saved views</b>
        <ul>
          @for (p of presets(); track p.id) {
            <li>
              @if (renaming() === p.id) {
                <input type="text" [value]="renameText()" aria-label="New name" (input)="renameText.set($any($event.target).value)" />
                <button type="button" class="tool" (click)="commitRename(p.id)">Save</button>
                <button type="button" class="tool" (click)="renaming.set(null)">Cancel</button>
              } @else {
                <button type="button" class="tool apply" [attr.aria-label]="'Apply ' + p.name" (click)="apply(p.id)">{{ p.name }}</button>
                <button type="button" class="tool" [attr.aria-label]="'Rename ' + p.name" (click)="startRename(p)">Rename</button>
                <button type="button" class="tool" [attr.aria-label]="'Delete ' + p.name" (click)="remove(p.id)">Delete</button>
              }
            </li>
          }
        </ul>
        <div class="row new">
          <label class="sr" for="oc-new-view">View name</label>
          <input id="oc-new-view" type="text" placeholder="Name this view" [value]="newName()" (input)="newName.set($any($event.target).value); error.set('')" />
          <button type="button" class="tool" (click)="save()">New</button>
        </div>
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
      </div>

      <div class="row"><button type="button" class="tool primary" (click)="done.emit()">Done</button></div>
    </section>
  `,
  styles: `
    :host { display: block; color: var(--ts-fg); font-family: var(--ts-font); }
    .custom { padding: 12px 14px; border-bottom: 1px solid var(--ts-line); background: var(--ts-bg2); display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
    .help { margin: 0; color: var(--ts-muted); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .grid { display: flex; flex-wrap: wrap; gap: 6px 14px; }
    label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    ul { margin: 0; padding: 0; list-style: none; }
    .chosen { display: flex; flex-direction: column; gap: 4px; max-width: 320px; }
    .item { display: flex; align-items: center; gap: 8px; padding: 2px 6px; background: var(--ts-bg); border: 1px solid var(--ts-line); border-radius: 6px; }
    .item label { flex: 1; }
    .grip { cursor: grab; color: var(--ts-muted); user-select: none; }
    .cdk-drag-preview { background: var(--ts-bg); border: 1px solid var(--ts-blue); border-radius: 6px; box-shadow: 0 8px 20px -10px var(--ts-shadow); padding: 2px 6px; display: flex; gap: 8px; }
    .cdk-drag-placeholder { opacity: 0.4; }
    .saved { display: flex; flex-direction: column; gap: 6px; }
    .saved li { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
    .saved li .apply { min-width: 120px; text-align: left; }
    .error { margin: 0; color: var(--ts-red); }
    input[type='text'] { font: inherit; padding: 4px 8px; border: 1px solid var(--ts-input-border); border-radius: 4px; background: var(--ts-input-bg); color: var(--ts-input-fg); }
    .tool, .mv {
      border: 1px solid var(--ts-outline); background: transparent; color: var(--ts-outline); border-radius: 4px;
      padding: 4px 10px; min-height: 32px; font: inherit; font-size: 13px; cursor: pointer;
    }
    .mv { min-width: 32px; padding: 4px; }
    .mv:disabled { opacity: 0.4; cursor: default; }
    .tool[aria-pressed='true'], .primary { background: var(--ts-blue); border-color: var(--ts-blue); color: var(--ts-on-accent); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
  `,
})
export class ColumnChooserComponent {
  /** Ordered ids of the columns currently in the Custom view. */
  readonly columns = input.required<string[]>();
  /** Saved custom presets (custom only). */
  readonly presets = input<CustomPreset[]>([]);
  /** Optional: initial mode; the toggle keeps its own state after that. */
  readonly initialMode = input<Mode>('mirrored', { alias: 'mode' });

  readonly columnsChange = output<string[]>();
  readonly savePreset = output<SavePresetEvent>();
  readonly renamePreset = output<RenamePresetEvent>();
  readonly deletePreset = output<string>();
  readonly modeChange = output<Mode>();
  readonly done = output<void>();
  /** A saved view was chosen: the parent makes its mode and columns the working Custom view. */
  readonly applyPreset = output<string>();

  protected readonly mode = linkedSignal<Mode>(() => this.initialMode());
  protected readonly newName = signal('');
  protected readonly renaming = signal<string | null>(null);
  protected readonly renameText = signal('');
  protected readonly error = signal('');

  private readonly available = computed<ColumnDef[]>(() =>
    Object.values(COLUMNS).filter((c) => c.customisable && c.scope === (this.mode() === 'mirrored' ? 'side' : 'strike')),
  );
  protected readonly chosen = computed(() => {
    const byId = new Map(this.available().map((c) => [c.id, c]));
    return this.columns().flatMap((id) => byId.get(id) ?? []);
  });
  protected readonly unchosen = computed(() => {
    const on = new Set(this.columns());
    return this.available().filter((c) => !on.has(c.id));
  });

  protected setMode(m: Mode): void {
    if (m === this.mode()) return;
    this.mode.set(m);
    this.error.set('');
    this.modeChange.emit(m);
    // Columns of the other scope cannot render in this mode; keep only the ones that can.
    this.columnsChange.emit(this.chosen().map((c) => c.id));
  }

  protected toggle(id: string): void {
    this.error.set('');
    const cur = this.chosen().map((c) => c.id);
    this.columnsChange.emit(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }

  protected move(i: number, delta: -1 | 1): void {
    const ids = this.chosen().map((c) => c.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    this.columnsChange.emit(ids);
  }

  protected drop(e: Pick<CdkDragDrop<unknown>, 'previousIndex' | 'currentIndex'>): void {
    const ids = this.chosen().map((c) => c.id);
    const [moved] = ids.splice(e.previousIndex, 1);
    if (moved === undefined) return;
    ids.splice(e.currentIndex, 0, moved);
    this.columnsChange.emit(ids);
  }

  protected save(): void {
    const name = this.newName().trim();
    if (!name) {
      this.error.set('Enter a name for this view.');
      return;
    }
    if (this.presets().length >= MAX_CUSTOM_PRESETS) {
      this.error.set(CUSTOM_LIMIT_MESSAGE);
      return;
    }
    this.error.set('');
    this.savePreset.emit({ name, mode: this.mode(), columns: this.chosen().map((c) => c.id) });
    this.newName.set('');
  }

  protected apply(id: string): void {
    this.error.set('');
    const p = this.presets().find((x) => x.id === id);
    if (p) this.mode.set(p.mode);
    this.applyPreset.emit(id);
  }

  protected remove(id: string): void {
    this.error.set('');
    this.deletePreset.emit(id);
  }

  protected startRename(p: CustomPreset): void {
    this.error.set('');
    this.renaming.set(p.id);
    this.renameText.set(p.name);
  }

  protected commitRename(id: string): void {
    this.error.set('');
    const name = this.renameText().trim();
    if (name) this.renamePreset.emit({ id, name });
    this.renaming.set(null);
  }
}
