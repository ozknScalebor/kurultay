import { forTerminal } from '../ui/symbols.js';
import type { Readable, Writable } from 'node:stream';
import { LineEditor, type Completer } from './editor.js';
import { KeyParser, fitWidth, type Key } from './keys.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface TermIO {
  input: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  output: Writable & { isTTY?: boolean; columns?: number; rows?: number };
}

/**
 * Owns the terminal: an interactive raw-mode prompt with live suggestions when
 * stdin is a TTY, and a plain line reader otherwise (pipes, scripts, tests).
 * While a long operation runs ("busy"), Ctrl+C is routed to its abort handler.
 */
export class Screen {
  readonly interactive: boolean;
  private parser = new KeyParser();
  private editor: LineEditor | undefined;
  private prompt = '';
  private renderedCursorRow = 0;
  private pending: ((v: string | null) => void) | undefined;
  private lines: string[] = [];
  private partial = '';
  private ended = false;
  private busyHandler: (() => void) | undefined;
  private lastInterrupt = 0;
  /** keys typed while no prompt was active (type-ahead during long operations) */
  private typeahead: Key[] = [];
  readonly history: string[];
  onExitRequest: (() => void) | undefined;
  /** status line shown under the prompt (workspace, branch, mode …) */
  private footer: (() => string) | undefined;
  private showFooter = true;
  /** long-running operation indicator */
  private activityState: { label: string; info?: () => string; started: number; frame: number; timer: NodeJS.Timeout; drawn: boolean } | undefined;

  constructor(
    private readonly io: TermIO,
    opts: { history?: string[]; forceInteractive?: boolean } = {},
  ) {
    this.history = opts.history ?? [];
    this.interactive = opts.forceInteractive ?? (!!io.input.isTTY && !!io.output.isTTY);
    if (typeof (io.input as { setEncoding?: (e: string) => void }).setEncoding === 'function') (io.input as unknown as { setEncoding: (e: string) => void }).setEncoding('utf8');
    io.input.on('data', (d: Buffer | string) => this.onData(String(d)));
    io.input.on('end', () => {
      this.ended = true;
      if (this.partial) {
        this.lines.push(this.partial);
        this.partial = '';
      }
      this.flushLines();
    });
    if (this.interactive) {
      io.input.setRawMode?.(true);
      this.write('\x1b[?2004h'); // bracketed paste
    }
    (io.input as { resume?: () => void }).resume?.();
  }

  get columns(): number {
    return this.io.output.columns || 100;
  }

  write(s: string): void {
    this.io.output.write(forTerminal(s));
  }

  /** Print text; a prompt or activity line on screen is redrawn below the text. */
  print(s = ''): void {
    const text = s.endsWith('\n') ? s : s + '\n';
    if (this.interactive && this.editor) {
      this.clearInput();
      this.write(text.replace(/\n/g, '\r\n'));
      this.render();
    } else if (this.interactive) {
      this.clearActivity();
      this.write(text.replace(/\n/g, '\r\n'));
      this.drawActivity();
    } else this.write(text);
  }

  /**
   * Show a spinner line ("⠹ Task · 12s · 3 LLM requests running") until the returned
   * function is called. Log lines printed meanwhile appear above it.
   */
  activity(label: string, info?: () => string): () => void {
    if (!this.interactive) return () => undefined;
    this.endActivity();
    const timer = setInterval(() => {
      if (!this.activityState) return;
      this.activityState.frame++;
      this.clearActivity();
      this.drawActivity();
    }, 120);
    timer.unref?.();
    this.activityState = { label, info, started: Date.now(), frame: 0, timer, drawn: false };
    this.drawActivity();
    return () => this.endActivity();
  }

  private endActivity(): void {
    if (!this.activityState) return;
    clearInterval(this.activityState.timer);
    this.clearActivity();
    this.activityState = undefined;
  }

  private clearActivity(): void {
    if (this.activityState?.drawn) {
      this.write('\r\x1b[2K');
      this.activityState.drawn = false;
    }
  }

  private drawActivity(): void {
    const a = this.activityState;
    if (!a || this.editor) return;
    const secs = Math.floor((Date.now() - a.started) / 1000);
    const extra = a.info?.() ?? '';
    const line = `${SPINNER[a.frame % SPINNER.length]} ${a.label} · ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}${extra ? ` · ${extra}` : ''} · Ctrl+C to cancel`;
    this.write(`\x1b[36m${fitWidth(line, this.columns - 1)}\x1b[39m`);
    a.drawn = true;
  }

  /** Read one line. Resolves null on EOF / Ctrl+D. `footer` is a status line drawn under the input. */
  readLine(prompt: string, completer?: Completer, footer?: () => string): Promise<string | null> {
    this.prompt = prompt;
    this.footer = footer;
    this.showFooter = true;
    this.clearActivity();
    if (!this.interactive) {
      this.write(prompt);
      return new Promise((resolve) => {
        this.pending = (v) => {
          this.write((v ?? '') + '\n');
          if (v && v.trim() && this.history[this.history.length - 1] !== v) this.history.push(v);
          resolve(v);
        };
        this.flushLines();
      });
    }
    this.editor = new LineEditor(completer, this.history);
    this.renderedCursorRow = 0;
    this.render();
    const p = new Promise<string | null>((resolve) => {
      this.pending = resolve;
    });
    // replay what was typed while the previous operation was running
    const queued = this.typeahead;
    this.typeahead = [];
    for (let i = 0; i < queued.length && this.pending; i++) {
      this.onKey(queued[i]);
      if (!this.pending) this.typeahead = queued.slice(i + 1);
    }
    return p;
  }

  /** Yes/no question (default no). */
  async confirm(question: string): Promise<boolean> {
    const a = await this.readLine(`${question} [y/N] `);
    return /^(y|yes)$/i.test((a ?? '').trim());
  }

  /** Route Ctrl+C to `onInterrupt` until the returned function is called. */
  busy(onInterrupt: () => void): () => void {
    this.busyHandler = onInterrupt;
    return () => {
      if (this.busyHandler === onInterrupt) this.busyHandler = undefined;
    };
  }

  close(): void {
    this.endActivity();
    if (this.interactive) {
      this.write('\x1b[?2004l');
      this.io.input.setRawMode?.(false);
    }
    (this.io.input as { pause?: () => void }).pause?.();
  }

  // ---- internals

  private onData(data: string): void {
    if (!this.interactive) {
      const parts = (this.partial + data).split(/\r?\n/);
      this.partial = parts.pop() ?? '';
      this.lines.push(...parts);
      this.flushLines();
      return;
    }
    for (const key of this.parser.feed(data)) this.onKey(key);
  }

  private flushLines(): void {
    if (!this.pending) return;
    if (this.lines.length) {
      const p = this.pending;
      this.pending = undefined;
      p(this.lines.shift()!);
    } else if (this.ended) {
      const p = this.pending;
      this.pending = undefined;
      p(null);
    }
  }

  private onKey(key: Key): void {
    if (!this.editor || !this.pending) {
      if (key.name === 'ctrl-c') {
        this.typeahead = [];
        if (this.busyHandler) this.busyHandler();
        else this.onExitRequest?.();
      } else if (this.typeahead.length < 2000) this.typeahead.push(key);
      return;
    }
    const action = this.editor.handle(key);
    if (!action) return this.render();
    if (action.type === 'clear-screen') {
      this.write('\x1b[2J\x1b[H');
      this.renderedCursorRow = 0;
      return this.render();
    }
    if (action.type === 'interrupt') {
      const now = Date.now();
      if (now - this.lastInterrupt < 1500) return this.finish(null);
      this.lastInterrupt = now;
      this.clearInput();
      this.write('\x1b[2m(press Ctrl+C again or type /exit to quit)\x1b[22m\r\n');
      this.renderedCursorRow = 0;
      return this.render();
    }
    if (action.type === 'eof') return this.finish(null);
    // submit: leave the final text on screen, without menu and status line
    this.editor.set(action.text);
    this.editor.menu = undefined;
    this.showFooter = false;
    this.render();
    const v = this.editor.view(this.prompt, this.columns);
    const down = v.rows.length - 1 - this.renderedCursorRow;
    if (down > 0) this.write(`\x1b[${down}B`);
    this.write('\r\n');
    this.finish(action.text);
  }

  private finish(v: string | null): void {
    if (v === null) {
      this.clearInput();
    }
    this.editor = undefined;
    this.renderedCursorRow = 0;
    const p = this.pending;
    this.pending = undefined;
    this.drawActivity();
    p?.(v);
  }

  private clearInput(): void {
    if (this.renderedCursorRow > 0) this.write(`\x1b[${this.renderedCursorRow}A`);
    this.write('\r\x1b[J');
    this.renderedCursorRow = 0;
  }

  private render(): void {
    if (!this.editor) return;
    const v = this.editor.view(this.prompt, this.columns);
    const rows = [...v.rows];
    if (this.footer && this.showFooter) {
      const f = this.footer();
      if (f) rows.push(`\x1b[2m${fitWidth(f, this.columns - 1)}\x1b[22m`);
    }
    this.clearInput();
    this.write(rows.join('\r\n'));
    const up = rows.length - 1 - v.cursorRow;
    if (up > 0) this.write(`\x1b[${up}A`);
    this.write('\r');
    if (v.cursorCol > 0) this.write(`\x1b[${v.cursorCol}C`);
    this.renderedCursorRow = v.cursorRow;
  }
}
