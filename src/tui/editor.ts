import { displayWidth, fitWidth, type Key } from './keys.js';

export interface Suggestion {
  /** text inserted when accepted */
  value: string;
  /** shown in the menu (defaults to value) */
  label?: string;
  description?: string;
  /** submit the line right after this suggestion is accepted with Enter (overrides Completion.submitOnEnter) */
  submit?: boolean;
}

export interface Completion {
  items: Suggestion[];
  /** code-point range of the input that an accepted suggestion replaces */
  from: number;
  to: number;
  /** after Enter accepted a suggestion, submit the line too (slash commands) */
  submitOnEnter?: boolean;
  /**
   * Enter accepts the highlighted suggestion even if the user did not move
   * through the menu (command palette, numbered choices). Otherwise Enter only
   * accepts after ↑/↓ navigation and submits the typed text as is (paths).
   */
  autoAccept?: boolean;
}

export type Completer = (text: string, cursor: number) => Completion | undefined;

export type EditorAction = { type: 'submit'; text: string } | { type: 'interrupt' } | { type: 'eof' } | { type: 'clear-screen' } | undefined;

/**
 * Single/multi-line input editor with history and a suggestion menu
 * (the "/" command palette and @file / path completion), modelled on the
 * prompt editors of omp, Qwen Code and Claude Code. Pure state machine:
 * the console feeds keys and renders `view()`.
 */
export class LineEditor {
  private chars: string[] = [];
  private cursor = 0;
  private historyIndex = -1;
  private draft: string[] = [];
  menu: Completion | undefined;
  selected = 0;
  /** menu dismissed with Esc until the text changes */
  private dismissed = false;
  /** user moved through the menu with ↑/↓ since it opened */
  private navigated = false;

  constructor(
    private readonly completer?: Completer,
    readonly history: string[] = [],
  ) {}

  get text(): string {
    return this.chars.join('');
  }

  get cursorPos(): number {
    return this.cursor;
  }

  set(text: string, cursor = Array.from(text).length): void {
    this.chars = Array.from(text);
    this.cursor = Math.max(0, Math.min(cursor, this.chars.length));
    this.dismissed = false;
    this.refreshMenu();
  }

  reset(): void {
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = -1;
    this.menu = undefined;
    this.dismissed = false;
  }

  handle(key: Key): EditorAction {
    const menuOpen = !!this.menu?.items.length;
    switch (key.name) {
      case 'char':
      case 'paste':
        this.insert(key.text ?? '');
        break;
      case 'enter': {
        if (this.chars[this.cursor - 1] === '\\') {
          // backslash-enter continues on a new line
          this.chars.splice(this.cursor - 1, 1, '\n');
          this.refreshMenu();
          break;
        }
        if (menuOpen && (this.navigated || this.menu!.autoAccept)) {
          const item = this.menu!.items[this.selected];
          const submit = item.submit ?? this.menu!.submitOnEnter;
          const before = this.text;
          this.accept();
          // accepting changed the text (e.g. "/he" → "/help") and the caller wants to see it first
          if (!submit && this.text !== before) break;
        }
        const text = this.text;
        if (text.trim() && this.history[this.history.length - 1] !== text) this.history.push(text);
        this.reset();
        return { type: 'submit', text };
      }
      case 'tab':
        if (menuOpen) this.accept();
        else this.refreshMenu(true);
        break;
      case 'shift-tab':
        if (menuOpen) this.move(-1);
        break;
      case 'escape':
        if (menuOpen) {
          this.menu = undefined;
          this.dismissed = true;
        } else if (this.chars.length) this.set('');
        break;
      case 'up':
        if (menuOpen) this.move(-1);
        else if (this.lineOf(this.cursor) > 0) this.verticalMove(-1);
        else this.historyStep(-1);
        break;
      case 'down':
        if (menuOpen) this.move(1);
        else if (this.lineOf(this.cursor) < this.text.split('\n').length - 1) this.verticalMove(1);
        else this.historyStep(1);
        break;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        this.refreshMenu();
        break;
      case 'right':
        this.cursor = Math.min(this.chars.length, this.cursor + 1);
        this.refreshMenu();
        break;
      case 'home':
      case 'ctrl-a':
        this.cursor = this.lineStart(this.cursor);
        break;
      case 'end':
      case 'ctrl-e':
        this.cursor = this.lineEnd(this.cursor);
        break;
      case 'word-left':
        this.cursor = this.wordStart(this.cursor);
        break;
      case 'word-right': {
        let i = this.cursor;
        while (i < this.chars.length && /\s/.test(this.chars[i])) i++;
        while (i < this.chars.length && !/\s/.test(this.chars[i])) i++;
        this.cursor = i;
        break;
      }
      case 'backspace':
        if (this.cursor > 0) {
          this.chars.splice(this.cursor - 1, 1);
          this.cursor--;
          this.textChanged();
        }
        break;
      case 'delete':
        if (this.cursor < this.chars.length) {
          this.chars.splice(this.cursor, 1);
          this.textChanged();
        }
        break;
      case 'ctrl-u':
        this.chars.splice(this.lineStart(this.cursor), this.cursor - this.lineStart(this.cursor));
        this.cursor = this.lineStart(this.cursor);
        this.textChanged();
        break;
      case 'ctrl-k':
        this.chars.splice(this.cursor, this.lineEnd(this.cursor) - this.cursor);
        this.textChanged();
        break;
      case 'ctrl-w': {
        const start = this.wordStart(this.cursor);
        this.chars.splice(start, this.cursor - start);
        this.cursor = start;
        this.textChanged();
        break;
      }
      case 'ctrl-c':
        if (this.chars.length) {
          this.reset();
          break;
        }
        return { type: 'interrupt' };
      case 'ctrl-d':
        if (!this.chars.length) return { type: 'eof' };
        if (this.cursor < this.chars.length) {
          this.chars.splice(this.cursor, 1);
          this.textChanged();
        }
        break;
      case 'ctrl-l':
        return { type: 'clear-screen' };
      default:
        break;
    }
    return undefined;
  }

  private insert(text: string): void {
    const add = Array.from(text.replace(/\r\n?/g, '\n').replace(/\t/g, '  '));
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
    this.textChanged();
  }

  private textChanged(): void {
    this.dismissed = false;
    this.historyIndex = -1;
    this.refreshMenu();
  }

  /** Recompute suggestions. `force` opens the menu on Tab even where it is not shown automatically. */
  refreshMenu(force = false): void {
    if (!this.completer || (this.dismissed && !force)) {
      this.menu = undefined;
      return;
    }
    const c = this.completer(this.text, this.cursor);
    const prev = this.menu?.items[this.selected]?.value;
    if (!c || !this.menu || c.from !== this.menu.from) this.navigated = false;
    this.menu = c && c.items.length ? c : undefined;
    const keep = this.menu ? this.menu.items.findIndex((x) => x.value === prev) : -1;
    this.selected = keep >= 0 ? keep : 0;
    // a single exact match on Tab is accepted directly (shell-like)
    if (force && this.menu?.items.length === 1) this.accept();
  }

  private move(d: number): void {
    this.navigated = true;
    const n = this.menu!.items.length;
    this.selected = (this.selected + d + n) % n;
  }

  private accept(): void {
    const m = this.menu;
    if (!m) return;
    const item = m.items[this.selected];
    const value = Array.from(item.value);
    this.chars.splice(m.from, m.to - m.from, ...value);
    this.cursor = m.from + value.length;
    this.menu = undefined;
    // keep completing (e.g. into a sub-directory) without reopening the same list
    const c = this.completer?.(this.text, this.cursor);
    if (c && c.items.length && !(c.items.length === 1 && c.items[0].value === item.value)) {
      this.menu = c;
      this.selected = 0;
    }
  }

  private historyStep(d: number): void {
    if (!this.history.length) return;
    if (this.historyIndex === -1) {
      if (d > 0) return;
      this.draft = [...this.chars];
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex + d;
    if (next < 0) return;
    if (next >= this.history.length) {
      this.historyIndex = -1;
      this.chars = [...this.draft];
    } else {
      this.historyIndex = next;
      this.chars = Array.from(this.history[next]);
    }
    this.cursor = this.chars.length;
    this.menu = undefined;
  }

  private lineStart(pos: number): number {
    let i = pos;
    while (i > 0 && this.chars[i - 1] !== '\n') i--;
    return i;
  }

  private lineEnd(pos: number): number {
    let i = pos;
    while (i < this.chars.length && this.chars[i] !== '\n') i++;
    return i;
  }

  private lineOf(pos: number): number {
    return this.chars.slice(0, pos).filter((c) => c === '\n').length;
  }

  private verticalMove(d: number): void {
    const col = this.cursor - this.lineStart(this.cursor);
    const target = d < 0 ? this.lineStart(this.cursor) - 1 : this.lineEnd(this.cursor) + 1;
    const start = this.lineStart(target);
    this.cursor = Math.min(start + col, this.lineEnd(target));
  }

  private wordStart(pos: number): number {
    let i = pos;
    while (i > 0 && /\s/.test(this.chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.chars[i - 1])) i--;
    return i;
  }

  /**
   * Layout for rendering: prompt + text wrapped to `width`, then up to
   * `maxMenu` suggestion rows. Returns the rows and where the cursor sits.
   */
  view(prompt: string, width: number, maxMenu = 8): { rows: string[]; cursorRow: number; cursorCol: number; menuRows: number } {
    const promptW = displayWidth(prompt);
    const indent = ' '.repeat(promptW);
    const rows: string[] = [];
    let cursorRow = 0;
    let cursorCol = promptW;
    let row = prompt;
    let col = promptW;
    const w = Math.max(10, width);
    for (let i = 0; i <= this.chars.length; i++) {
      if (i === this.cursor) {
        if (col >= w) {
          rows.push(row);
          row = indent;
          col = promptW;
        }
        cursorRow = rows.length;
        cursorCol = col;
      }
      if (i === this.chars.length) break;
      const ch = this.chars[i];
      if (ch === '\n') {
        rows.push(row);
        row = indent;
        col = promptW;
        continue;
      }
      const cw = displayWidth(ch);
      if (col + cw > w) {
        rows.push(row);
        row = indent;
        col = promptW;
      }
      row += ch;
      col += cw;
    }
    rows.push(row);
    let menuRows = 0;
    if (this.menu?.items.length) {
      const items = this.menu.items;
      const start = Math.max(0, Math.min(this.selected - Math.floor(maxMenu / 2), items.length - maxMenu));
      const shown = items.slice(start, start + maxMenu);
      const labelW = Math.min(28, Math.max(...shown.map((s) => displayWidth(s.label ?? s.value))) + 2);
      for (let k = 0; k < shown.length; k++) {
        const s = shown[k];
        const idx = start + k;
        const label = s.label ?? s.value;
        const pad = ' '.repeat(Math.max(1, labelW - displayWidth(label)));
        const line = fitWidth(`${idx === this.selected ? '›' : ' '} ${label}${pad}${s.description ?? ''}`, w - 1);
        rows.push(idx === this.selected ? `\x1b[7m${line}\x1b[27m` : `\x1b[2m${line}\x1b[22m`);
        menuRows++;
      }
      if (items.length > shown.length) {
        rows.push(`\x1b[2m  … ${items.length - shown.length} more (↑/↓)\x1b[22m`);
        menuRows++;
      }
    }
    return { rows, cursorRow, cursorCol, menuRows };
  }
}
