/**
 * Terminal symbols with a plain-ASCII fallback. Legacy Windows consoles
 * (cmd.exe / PowerShell in conhost with Consolas or raster fonts) have no
 * glyphs for braille spinners, check marks, bars or emoji and show boxes or
 * question marks instead. In ASCII mode every line written to the terminal
 * goes through toAscii().
 *
 * KURULTAY_ASCII=1 forces ASCII, KURULTAY_ASCII=0 forces Unicode.
 */

export function detectUnicode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.KURULTAY_ASCII === '1') return false;
  if (env.KURULTAY_ASCII === '0') return true;
  if (platform !== 'win32') return !/ascii|ansi_x3/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || 'UTF-8');
  // Windows Terminal, VS Code, ConEmu, mintty/Git Bash and other modern hosts render Unicode
  return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || /xterm|cygwin/i.test(env.TERM ?? ''));
}

let unicode = detectUnicode();

export function unicodeEnabled(): boolean {
  return unicode;
}

/** Test hook / --ascii flag. */
export function setUnicode(on: boolean): void {
  unicode = on;
}

const SPINNER = '|/-\\';
const BRAILLE = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

// one character for one character: the console's line editor measures widths before writing
const MAP: Record<string, string> = {
  '✓': '+', '✔': '+', '✗': 'x', '✘': 'x', '✖': 'x', '⚠': '!', '⚡': '!',
  '→': '>', '←': '<', '↑': '^', '↓': 'v', '↶': '<', '⇒': '>', '›': '>', '❯': '>', '▸': '>', '▶': '>', '⑂': '|',
  '•': '*', '●': '*', '○': 'o', '◆': '*', '⟡': '=', '⎇': '@', '★': '*',
  '·': '-', '…': '.', '—': '-', '–': '-', '−': '-', '×': 'x', '÷': '/', '≥': '>', '≤': '<', '≈': '~', '°': 'o',
  '▰': '#', '▱': '.', '█': '#', '░': '.', '▏': '|',
  '─': '-', '━': '-', '│': '|', '┃': '|', '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+', '┤': '+', '┬': '+', '┴': '+', '┼': '+',
  '═': '=', '║': '|', '╔': '+', '╗': '+', '╚': '+', '╝': '+', '╠': '+', '╣': '+', '╦': '+', '╩': '+', '╬': '+',
  '“': '"', '”': '"', '‘': "'", '’': "'", '«': '"', '»': '"',
  'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I', 'ö': 'o', 'Ö': 'O', 'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U',
};

/** Replace characters a legacy console cannot draw. ANSI escape sequences are ASCII and pass through. */
export function toAscii(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) out += ch;
    else if (MAP[ch] !== undefined) out += MAP[ch];
    else if (BRAILLE.includes(ch)) out += SPINNER[BRAILLE.indexOf(ch) % SPINNER.length];
    else {
      // other accented letters: drop the accent (é → e); anything else becomes '?'
      const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += /^[\x20-\x7e]+$/.test(plain) ? plain : '?';
    }
  }
  return out;
}

/** Apply the fallback when the terminal cannot show Unicode. */
export function forTerminal(text: string): string {
  return unicode ? text : toAscii(text);
}
