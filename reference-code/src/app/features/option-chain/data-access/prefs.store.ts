import { Injectable, InjectionToken, inject } from '@angular/core';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CustomPreset { id: string; name: string; mode: 'mirrored' | 'strike'; columns: string[] }

/** The working Custom view: what the Custom preset shows now. */
export interface CustomView { mode: 'mirrored' | 'strike'; columns: string[] }

export interface Prefs {
  version: 1;
  preset: string;
  strikeCount: number | 'all';
  customPresets: CustomPreset[];
  numberFormat: 'lakh' | 'intl';
  /** Optional (absent until the user edits Custom), so older v1 records stay valid. */
  custom?: CustomView;
}

export const MAX_CUSTOM_PRESETS = 5;
export const CUSTOM_LIMIT_MESSAGE = 'You can save up to 5 custom views.';

export const PREFS_STORAGE = new InjectionToken<StorageLike | null>('PREFS_STORAGE', {
  providedIn: 'root',
  factory: () => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  },
});

const keyFor = (userId: string): string => `ts.optionChain.prefs.v1:${userId}`;
const defaults = (): Prefs => ({ version: 1, preset: 'default', strikeCount: 16, customPresets: [], numberFormat: 'lakh' });

function customView(c: unknown): { custom?: CustomView } {
  if (!c || typeof c !== 'object') return {};
  const { mode, columns } = c as Partial<CustomView>;
  if ((mode !== 'mirrored' && mode !== 'strike') || !Array.isArray(columns)) return {};
  return { custom: { mode, columns: columns.filter((x): x is string => typeof x === 'string') } };
}

@Injectable({ providedIn: 'root' })
export class PrefsStore {
  private readonly storage = inject(PREFS_STORAGE);

  load(userId: string): Prefs {
    try {
      const raw = this.storage?.getItem(keyFor(userId));
      if (!raw) return defaults();
      const p = JSON.parse(raw) as Partial<Prefs> | null;
      if (!p || typeof p !== 'object' || p.version !== 1) return defaults();
      const d = defaults();
      return {
        version: 1,
        preset: typeof p.preset === 'string' ? p.preset : d.preset,
        strikeCount: p.strikeCount === 'all' || typeof p.strikeCount === 'number' ? p.strikeCount : d.strikeCount,
        customPresets: Array.isArray(p.customPresets) ? p.customPresets.slice(0, MAX_CUSTOM_PRESETS) : d.customPresets,
        numberFormat: p.numberFormat === 'intl' ? 'intl' : 'lakh',
        ...customView(p.custom),
      };
    } catch {
      return defaults();
    }
  }

  save(userId: string, p: Prefs): void {
    try {
      this.storage?.setItem(keyFor(userId), JSON.stringify(p));
    } catch {
      /* storage unavailable or full: preferences are best-effort */
    }
  }

  addCustomPreset(userId: string, preset: CustomPreset): { ok: true } | { ok: false; reason: string } {
    const p = this.load(userId);
    if (p.customPresets.length >= MAX_CUSTOM_PRESETS) {
      return { ok: false, reason: CUSTOM_LIMIT_MESSAGE };
    }
    this.save(userId, { ...p, customPresets: [...p.customPresets, preset] });
    return { ok: true };
  }
}
