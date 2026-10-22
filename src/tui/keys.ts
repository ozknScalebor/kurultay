/**
 * Raw terminal input → key events (no dependencies).
 * Handles printable text (incl. multi-byte UTF-8), control keys, CSI/SS3
 * escape sequences for arrows/home/end/delete and bracketed paste.
 */

export type KeyName =
  | 'char'
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'tab'
  | 'shift-tab'
  | 'escape'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'ctrl-k'
  | 'ctrl-l'
  | 'ctrl-u'
  | 'ctrl-w'
  | 'word-left'
  | 'word-right'
  | 'pageup'
  | 'pagedown'
  | 'paste'
  | 'unknown';

export interface Key {
  name: KeyName;
  /** text for 'char' and 'paste' */
  text?: string;
}

const CSI: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift-tab',
  '1~': 'home',
  '7~': 'home',
  '4~': 'end',
  '8~': 'end',
  '3~': 'delete',
  '5~': 'pageup',
  '6~': 'pagedown',
  '1;5C': 'word-right',
  '1;5D': 'word-left',
  '1;3C': 'word-right',
  '1;3D': 'word-left',
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Stateful parser: bracketed paste may be split across chunks, so the parser
 * keeps an open paste buffer between calls.
 */
export class KeyParser {
  private paste: string | undefined;

  feed(data: string): Key[] {
    const keys: Key[] = [];
    let i = 0;
    const pushChar = (ch: string) => {
      const last = keys[keys.length - 1];
      // coalesce consecutive printable characters (fast typing / unbracketed paste)
      if (last?.name === 'char') last.text += ch;
      else keys.push({ name: 'char', text: ch });
    };
    while (i < data.length) {
      if (this.paste !== undefined) {
        const end = data.indexOf(PASTE_END, i);
        if (end < 0) {
          this.paste += data.slice(i);
          return keys;
        }
        this.paste += data.slice(i, end);
        keys.push({ name: 'paste', text: this.paste.replace(/\r\n?/g, '\n') });
        this.paste = undefined;
        i = end + PASTE_END.length;
        continue;
      }
      if (data.startsWith(PASTE_START, i)) {
        this.paste = '';
        i += PASTE_START.length;
        continue;
      }
      const ch = data[i];
      if (ch === '\x1b') {
        const next = data[i + 1];
        if (next === '[' || next === 'O') {
          // CSI / SS3: parameters then a final byte in @-~
          let j = i + 2;
          while (j < data.length && !/[@-~]/.test(data[j])) j++;
          const body = data.slice(i + 2, j + 1);
          keys.push({ name: CSI[body] ?? 'unknown' });
          i = j + 1;
          continue;
        }
        if (next === 'b' || next === 'f') {
          keys.push({ name: next === 'b' ? 'word-left' : 'word-right' });
          i += 2;
          continue;
        }
        if (next === '\x7f') {
          keys.push({ name: 'ctrl-w' });
          i += 2;
          continue;
        }
        keys.push({ name: 'escape' });
        i++;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') {
        keys.push({ name: 'enter' });
        // treat CRLF as one enter
        i += ch === '\r' && data[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
      else if (ch === '\t') keys.push({ name: 'tab' });
      else if (code === 3) keys.push({ name: 'ctrl-c' });
      else if (code === 4) keys.push({ name: 'ctrl-d' });
      else if (code === 1) keys.push({ name: 'ctrl-a' });
      else if (code === 5) keys.push({ name: 'ctrl-e' });
      else if (code === 11) keys.push({ name: 'ctrl-k' });
      else if (code === 12) keys.push({ name: 'ctrl-l' });
      else if (code === 21) keys.push({ name: 'ctrl-u' });
      else if (code === 23) keys.push({ name: 'ctrl-w' });
      else if (code === 2) keys.push({ name: 'left' });
      else if (code === 6) keys.push({ name: 'right' });
      else if (code === 16) keys.push({ name: 'up' });
      else if (code === 14) keys.push({ name: 'down' });
      else if (code < 32) keys.push({ name: 'unknown' });
      else pushChar(ch);
      i++;
    }
    return keys;
  }
}

/** Terminal column width of a string (wide CJK / emoji count 2, combining marks 0, ANSI codes 0). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    // emoji-presentation symbols in the BMP (✅ ❌ ⚡ ✨ ⏳ …); other dingbats such as ❯ ✓ ● are narrow
    [0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55].includes(cp) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Truncate to a display width, adding an ellipsis when cut. */
export function fitWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}
