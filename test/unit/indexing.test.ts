import assert from 'node:assert/strict';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathFromLine } from '../../src/agent/edits.js';
import { chunkFile } from '../../src/index/bm25.js';
import { resolveImports, type GraphFile } from '../../src/index/graph.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { isProbablyBinary, scanProject } from '../../src/index/scanner.js';
import { extractSymbols, stripCommentsAndStrings } from '../../src/index/symbols.js';
import { tmpProject } from '../helpers.js';

const names = (src: string, lang: string) => extractSymbols(src, lang).defs.map((d) => `${d.kind}:${d.parent ? d.parent + '.' : ''}${d.name}`);

describe('symbol extraction', () => {
  it('C: functions, K&R style, macros, typedefs, prototypes ignored, control flow ignored', () => {
    const src = `#include <stdint.h>
#define BUF_SIZE 64
#define MIN(a,b) ((a)<(b)?(a):(b))
typedef enum { IDLE, BUSY } state_t;
typedef struct dev {
  int fd;
} dev_t;
typedef void (*cb_t)(int);
int proto_only(int x);
static inline uint32_t crc_step(uint32_t c, uint8_t b) {
  for (int i = 0; i < 8; i++) { if (c & 1) c ^= b; }
  return c;
}
void
gnu_style(void)
{
  while (1) { break; }
}
`;
    assert.deepEqual(names(src, 'c'), ['macro:BUF_SIZE', 'macro:MIN', 'type:state_t', 'struct:dev', 'type:dev_t', 'function:crc_step', 'function:gnu_style']);
  });

  it('ignores definitions inside comments and strings', () => {
    const src = `/* int fake(void) {\n} */\n// void also_fake(int a) {\nconst char *s = "int str_fake(void) {";\nint real(void) {\n  return 0;\n}\n`;
    assert.deepEqual(names(src, 'c'), ['function:real']);
    const clean = stripCommentsAndStrings(src, 'c');
    assert.equal(clean.split('\n').length, src.split('\n').length, 'line structure preserved');
    assert.ok(!clean.includes('fake'));
  });

  it('C++: namespaces, templates, enum class, out-of-line methods, destructors, using aliases', () => {
    const src = `namespace hw {
template <typename T>
class Ring final {
public:
  explicit Ring(size_t n);
  bool push(const T &v) {
    return true;
  }
};
enum class Mode { A, B };
using Buffer = std::vector<uint8_t>;
template <typename T>
Ring<T>::~Ring() {
}
Status Driver::start(int port) const noexcept {
  return Status::Ok;
}
}
`;
    const got = names(src, 'cpp');
    for (const want of ['namespace:hw', 'class:Ring', 'method:Ring.push', 'enum:Mode', 'type:Buffer', 'method:Driver.start']) assert.ok(got.includes(want), `${want} in ${got.join(', ')}`);
  });

  it('Java/Kotlin/C#: classes, interfaces, enums, records, methods with annotations and generics', () => {
    const java = `package a.b;
import java.util.List;
@Service
public final class OrderService implements Svc {
  @Override
  public synchronized List<Order> find(String id) throws IOException {
    return List.of();
  }
  private static <T extends Comparable<T>> T max(T a, T b) {
    return a;
  }
  public enum Status { NEW, DONE }
  record Pair(int a, int b) {}
}`;
    const got = names(java, 'java');
    for (const want of ['class:OrderService', 'method:OrderService.find', 'method:OrderService.max', 'enum:Status', 'class:Pair']) assert.ok(got.includes(want), `${want} in ${got.join(', ')}`);
    assert.deepEqual(extractSymbols(java, 'java').imports, ['java.util.List']);
    const kt = `class Repo(private val db: Db) {\n  fun load(id: Int): User? {\n    return null\n  }\n  suspend fun save(u: User) = db.put(u)\n}\ninterface Store {}\n`;
    const k = names(kt, 'kotlin');
    for (const want of ['class:Repo', 'method:Repo.load', 'method:Repo.save', 'interface:Store']) assert.ok(k.includes(want), `${want} in ${k.join(', ')}`);
    const cs = `using System.IO;\nnamespace App {\n  public class Reader {\n    public async Task<string> ReadAll(string path)\n    {\n      return "";\n    }\n  }\n}\n`;
    const c = names(cs, 'csharp');
    assert.ok(c.includes('class:Reader') && c.includes('method:Reader.ReadAll'), c.join(', '));
    assert.deepEqual(extractSymbols(cs, 'csharp').imports, ['System.IO']);
  });

  it('Python: nested classes, async defs, constants and docstrings', () => {
    const py = `"""module docstring def fake():"""\nimport os\nfrom .core import engine\nfrom ..util.io import read\nTIMEOUT = 5\nclass Outer:\n    class Inner:\n        def m(self):\n            pass\n    async def run(self):\n        """def nope(): pass"""\n        return 1\ndef top(a, b=2):\n    return a\n`;
    const got = names(py, 'python');
    assert.deepEqual(got, ['const:TIMEOUT', 'class:Outer', 'class:Inner', 'method:Inner.m', 'method:Outer.run', 'function:top']);
    assert.deepEqual(extractSymbols(py, 'python').imports, ['os', '.core', '..util.io']);
  });

  it('JS/TS, Go and Rust', () => {
    const ts = `import { a } from './a.js';\nexport interface Opts { x: number }\nexport type Id = string;\nexport enum Color { Red }\nexport default class Svc {\n  private readonly n = 1;\n  constructor() {}\n  public async fetch(id: Id): Promise<void> {\n  }\n  get size(): number {\n    return 1;\n  }\n}\nexport function* gen() {}\nconst helper = async (x) => x;\nexport const LIMIT = 10;\n`;
    const got = names(ts, 'typescript');
    for (const want of ['interface:Opts', 'type:Id', 'enum:Color', 'class:Svc', 'method:Svc.fetch', 'method:Svc.size', 'function:gen', 'function:helper', 'const:LIMIT']) assert.ok(got.includes(want), `${want} in ${got.join(', ')}`);
    assert.ok(!got.includes('method:Svc.constructor'));
    assert.deepEqual(extractSymbols(ts, 'typescript').imports, ['./a.js']);
    const go = `package main\nimport (\n  "fmt"\n  "example.com/app/store"\n)\ntype Store interface { Get() }\nfunc New() *Server { return nil }\nfunc (s Server) Handle(w Writer) {}\nfunc Map[T any](xs []T) {}\n`;
    assert.deepEqual(names(go, 'go'), ['interface:Store', 'function:New', 'method:Server.Handle', 'function:Map']);
    assert.deepEqual(extractSymbols(go, 'go').imports, ['fmt', 'example.com/app/store']);
    const rs = `use crate::io::Port;\nmod net;\npub struct Uart { port: Port }\npub trait Driver { fn init(&mut self); }\nimpl Driver for Uart {\n    fn init(&mut self) {}\n}\nimpl Uart {\n    pub async fn send(&self) {}\n}\npub(crate) fn helper() {}\n`;
    const r = names(rs, 'rust');
    for (const want of ['struct:Uart', 'interface:Driver', 'method:Uart.init', 'method:Uart.send', 'function:helper', 'module:net']) assert.ok(r.includes(want), `${want} in ${r.join(', ')}`);
  });

  it('falls back to generic extraction and counts references', () => {
    assert.deepEqual(names('entity uart_tx is\nend entity;\n', 'vhdl'), ['function:uart_tx']);
    const s = extractSymbols('void a(void) {\n  helper_x();\n  helper_x();\n}\n', 'c');
    assert.equal(s.refs.helper_x, 2);
    assert.equal(s.refs.void, undefined, 'keywords are not references');
  });
});

describe('import resolution', () => {
  it('resolves C includes, Java packages, Python modules and JS relative imports', () => {
    const files: GraphFile[] = [
      { path: 'src/drv/uart.c', lang: 'c', defs: [], refs: {}, imports: ['uart.h', 'common/types.h', 'stdio.h'] },
      { path: 'src/drv/uart.h', lang: 'c', defs: [], refs: {}, imports: [] },
      { path: 'include/common/types.h', lang: 'c', defs: [], refs: {}, imports: [] },
      { path: 'app/src/main/java/com/acme/App.java', lang: 'java', defs: [], refs: {}, imports: ['com.acme.util.Strings', 'java.util.List'] },
      { path: 'app/src/main/java/com/acme/util/Strings.java', lang: 'java', defs: [], refs: {}, imports: [] },
      { path: 'pkg/core/engine.py', lang: 'python', defs: [], refs: {}, imports: ['.helpers', 'pkg.io'] },
      { path: 'pkg/core/helpers.py', lang: 'python', defs: [], refs: {}, imports: [] },
      { path: 'pkg/io/__init__.py', lang: 'python', defs: [], refs: {}, imports: [] },
      { path: 'web/app.ts', lang: 'typescript', defs: [], refs: {}, imports: ['./lib/api.js', './lib', 'react'] },
      { path: 'web/lib/api.ts', lang: 'typescript', defs: [], refs: {}, imports: [] },
      { path: 'web/lib/index.ts', lang: 'typescript', defs: [], refs: {}, imports: [] },
    ];
    const r = resolveImports(files);
    assert.deepEqual([...r.get('src/drv/uart.c')!].sort(), ['include/common/types.h', 'src/drv/uart.h']);
    assert.deepEqual([...r.get('app/src/main/java/com/acme/App.java')!], ['app/src/main/java/com/acme/util/Strings.java']);
    assert.deepEqual([...r.get('pkg/core/engine.py')!].sort(), ['pkg/core/helpers.py', 'pkg/io/__init__.py']);
    assert.deepEqual([...r.get('web/app.ts')!].sort(), ['web/lib/api.ts', 'web/lib/index.ts']);
  });
});

describe('scanner', () => {
  it('walks without git, honours .gitignore, default ignores, binaries, size limit and globs', () => {
    const root = tmpProject({
      '.gitignore': 'secret/\n*.log\n# comment\n!keep.log\n',
      'src/a.c': 'int a;',
      'src/gen/b.pb.c': 'int b;',
      'secret/key.c': 'int k;',
      'debug.log': 'x',
      'node_modules/lib/index.js': 'x',
      'build/out.c': 'x',
      'img.png': 'x',
      'blob.dat.c': 'ab\u0000cd',
      'huge.c': 'x'.repeat(2000),
      'README.md': '# hi',
      'unknown.xyz': 'x',
      'empty.c': '',
      'Makefile': 'all:\n',
    });
    const paths = scanProject(root, { maxFileBytes: 1000 }).map((f) => f.path);
    assert.deepEqual(paths, ['.gitignore', 'Makefile', 'README.md', 'src/a.c', 'src/gen/b.pb.c'].filter((p) => p !== '.gitignore'));
    assert.deepEqual(scanProject(root, { exclude: ['*.pb.c'], maxFileBytes: 1000 }).map((f) => f.path), ['Makefile', 'README.md', 'src/a.c']);
    assert.deepEqual(scanProject(root, { include: ['src/**'], maxFileBytes: 1000 }).map((f) => f.path), ['src/a.c', 'src/gen/b.pb.c']);
    assert.equal(isProbablyBinary(join(root, 'blob.dat.c')), true);
    assert.equal(isProbablyBinary(join(root, 'src/a.c')), false);
    assert.equal(isProbablyBinary(join(root, 'does-not-exist')), true);
  });

  it('uses git ls-files when available (tracked + untracked, ignored excluded)', () => {
    const root = tmpProject({ '.gitignore': 'ignored.c\n', 'tracked.c': 'int t;', 'ignored.c': 'int i;' }, { git: true });
    writeFileSync(join(root, 'later.c'), 'int l;');
    const paths = scanProject(root).map((f) => f.path);
    assert.ok(paths.includes('tracked.c') && paths.includes('later.c'));
    assert.ok(!paths.includes('ignored.c'));
  });
});

describe('ProjectIndex', () => {
  const files: Record<string, string> = {
    'core/log.c': 'void log_write(const char *m) {\n  (void)m;\n}\n',
    'core/log.h': 'void log_write(const char *m);\n',
    'drivers/uart.c': '#include "log.h"\nint uart_open(void) {\n  log_write("open");\n  return 0;\n}\n',
    'drivers/spi.c': '#include "log.h"\nint spi_open(void) {\n  log_write("spi");\n  return 0;\n}\n',
    'app/main.c': 'int main(void) {\n  uart_open();\n  spi_open();\n  log_write("x");\n}\n',
    'README.md': '# demo\n',
  };

  it('builds, persists, reloads and updates incrementally', () => {
    const root = tmpProject(files);
    const state = join(root, '.kurultay');
    const idx = new ProjectIndex(root, state);
    assert.deepEqual(idx.build(), { added: 6, changed: 0, removed: 0, total: 6 });
    idx.save();
    const loaded = ProjectIndex.load(root, state)!;
    assert.equal(loaded.files.length, 6);
    // central file ranks above leaf
    assert.ok(loaded.data.ranks['core/log.c'] > loaded.data.ranks['app/main.c']);
    // summaries survive unchanged files, are marked stale when content changes
    loaded.file('drivers/spi.c')!.summary = 'SPI driver';
    loaded.file('drivers/spi.c')!.summaryHash = loaded.file('drivers/spi.c')!.hash;
    loaded.file('drivers/uart.c')!.summary = 'UART driver';
    loaded.file('drivers/uart.c')!.summaryHash = loaded.file('drivers/uart.c')!.hash;
    writeFileSync(join(root, 'drivers/uart.c'), files['drivers/uart.c'] + 'int uart_close(void) { return 0; }\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(root, 'drivers/uart.c'), future, future);
    writeFileSync(join(root, 'drivers/new.c'), 'int new_fn(void) { return 1; }\n');
    const s = loaded.build();
    assert.equal(s.added, 1);
    assert.equal(s.changed, 1);
    assert.equal(loaded.file('drivers/spi.c')!.summary, 'SPI driver');
    const stale = loaded.needsSummary().map((f) => f.path);
    assert.ok(stale.includes('drivers/uart.c') && !stale.includes('drivers/spi.c'));
    assert.ok(loaded.findSymbol('uart_close').length === 1);
    // touching mtime without changing content does not invalidate
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(root, 'drivers/spi.c'), later, later);
    assert.equal(loaded.build().changed, 0);
    assert.equal(loaded.file('drivers/spi.c')!.summary, 'SPI driver');
  });

  it('answers dependents/dependencies, search with path filters, focused repo maps and trees', () => {
    const root = tmpProject(files);
    const idx = new ProjectIndex(root, join(root, '.kurultay'));
    idx.build();
    const deps = idx.dependents('core/log.c').map((d) => d.path).sort();
    assert.deepEqual(deps, ['app/main.c', 'core/log.h', 'drivers/spi.c', 'drivers/uart.c']);
    assert.ok(idx.dependencies('app/main.c').some((d) => d.path === 'drivers/uart.c' && d.via.includes('uart_open')));
    assert.equal(idx.search('spi open', 3)[0].path, 'drivers/spi.c');
    assert.ok(idx.search('open', 10, 'drivers/*').every((h) => h.path.startsWith('drivers/')));
    const focused = idx.repoMap(60, { identifiers: ['spi_open'] });
    assert.ok(focused.indexOf('drivers/spi.c') < focused.indexOf('drivers/uart.c') || !focused.includes('drivers/uart.c'), focused);
    assert.ok(idx.repoMap(5).split('\n').length < 4, 'respects tiny budgets');
    assert.match(idx.tree(), /drivers\/ \(2\)/);
    const st = idx.stats();
    assert.equal(st.files, 6);
    assert.equal(st.langs.c, 5);
    assert.equal(ProjectIndex.load(join(root, 'nowhere'), join(root, 'nope')), undefined);
  });

  it('groups large directories into smaller modules', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 70; i++) many[`src/${i % 2 ? 'net' : 'fs'}/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    many['main.c'] = 'int main(void){return 0;}\n';
    const root = tmpProject(many);
    const idx = new ProjectIndex(root, join(root, '.k'));
    idx.build();
    const mods = idx.modules();
    assert.deepEqual(mods.map((m) => m.name).sort(), ['', 'src/fs', 'src/net']);
    assert.equal(mods.reduce((n, m) => n + m.files.length, 0), 71);
  });

  it('chunks files with overlap', () => {
    const text = Array.from({ length: 130 }, (_, i) => `l${i}`).join('\n');
    const chunks = chunkFile('f', text, 60, 10);
    assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine]), [[1, 60], [51, 110], [101, 130]]);
  });

  it('extracts extensionless build file names in edit blocks', () => {
    assert.equal(pathFromLine('Makefile'), 'Makefile');
    assert.equal(pathFromLine('version 1.2.3 is out'), undefined);
  });
});
