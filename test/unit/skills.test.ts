import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { executeTool, toolCatalogue, toolSpecs, type ToolContext } from '../../src/agent/tools.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { SKILL_TEMPLATE, SkillRegistry, selectSkillsFor } from '../../src/skills/skills.js';
import { fmBool, fmList, fmString, parseFrontmatter } from '../../src/util/frontmatter.js';
import { config, tmpProject } from '../helpers.js';

const skill = (fm: string, body = 'Adımlar') => `---\n${fm}\n---\n${body}\n`;

describe('front-matter parser', () => {
  it('handles scalars, quotes, lists, block scalars and nested maps', () => {
    const { data, body, present } = parseFrontmatter(
      [
        '﻿---',
        'name: pdf-tools',
        'description: "Extract \\"text\\" from PDFs"',
        "single: 'it''s'",
        'count: 42',
        'ratio: 1.5',
        'on: yes',
        'off: no',
        'nothing: ~',
        'empty:',
        'inline: [a, "b, c", 3]',
        'emptylist: []',
        'block:',
        '  - x',
        '  - "y"',
        '  -',
        'folded: >',
        '  one',
        '  two',
        'literal: |',
        '  line 1',
        '    line 2',
        'metadata:',
        '  author: me',
        '  version: 2',
        '# a comment',
        'not a key line',
        'trailing: value # comment',
        '---',
        'BODY',
      ].join('\r\n'),
    );
    assert.equal(present, true);
    assert.equal(body, 'BODY');
    assert.equal(data.name, 'pdf-tools');
    assert.equal(data.description, 'Extract "text" from PDFs');
    assert.equal(data.single, "it's");
    assert.equal(data.count, 42);
    assert.equal(data.ratio, 1.5);
    assert.equal(data.on, true);
    assert.equal(data.off, false);
    assert.equal(data.nothing, null);
    assert.deepEqual(data.empty, []);
    assert.deepEqual(data.inline, ['a', 'b, c', 3]);
    assert.deepEqual(data.emptylist, []);
    assert.deepEqual(data.block, ['x', 'y', '']);
    assert.equal(data.folded, 'one two');
    assert.equal(data.literal, 'line 1\n  line 2');
    assert.deepEqual(data.metadata, { author: 'me', version: 2 });
    assert.equal(data.trailing, 'value');
    assert.deepEqual(parseFrontmatter('no front matter'), { data: {}, body: 'no front matter', present: false });
  });

  it('coerces values with fmString / fmList / fmBool', () => {
    assert.equal(fmString(undefined), undefined);
    assert.equal(fmString(null), undefined);
    assert.equal(fmString(['a', 'b']), 'a, b');
    assert.equal(fmString({ a: 1 }), undefined);
    assert.equal(fmString(3), '3');
    assert.deepEqual(fmList(undefined), []);
    assert.deepEqual(fmList(''), []);
    assert.deepEqual(fmList({ a: 1 }), []);
    assert.deepEqual(fmList([' a ', '', 'b']), ['a', 'b']);
    assert.deepEqual(fmList('"src/**", lib/*.c'), ['src/**', 'lib/*.c']);
    assert.equal(fmBool(true), true);
    assert.equal(fmBool('Yes'), true);
    assert.equal(fmBool('off'), false);
    assert.equal(fmBool('maybe'), undefined);
    assert.equal(fmBool(1), undefined);
  });
});

describe('SkillRegistry discovery', () => {
  it('finds folder and legacy skills in every supported root, with diagnostics', () => {
    const home = tmpProject({
      '.agents/skills/user-only/SKILL.md': skill('name: user-only\ndescription: from home'),
      '.claude/skills/shared/SKILL.md': skill('name: shared\ndescription: home copy'),
    });
    const root = tmpProject({
      '.kurultay/skills/driver/SKILL.md': skill('name: driver\ndescription: Yeni sürücü ekleme\nkeywords: [sürücü, driver]\npaths: ["src/drivers/**"]\nargument-hint: <ad>\nallowed-tools: read_file edit_file'),
      '.kurultay/skills/driver/references/api.md': '# API',
      '.kurultay/skills/driver/scripts/gen.sh': 'echo hi',
      '.kurultay/skills/legacy.md': skill('description: tek dosyalık eski skill'),
      '.kurultay/skills/README.md': '# not a skill',
      '.kurultay/skills/notes.md': 'plain markdown without description',
      '.claude/skills/shared/SKILL.md': skill('name: shared\ndescription: project copy'),
      '.codex/skills/group/nested-one/SKILL.md': skill('name: nested-one\ndescription: nested two levels'),
      '.qwen/skills/no-desc/SKILL.md': skill('name: no-desc', ''),
      '.goose/skills/body-only/SKILL.md': skill('name: body-only', 'İlk satır açıklama olur'),
      '.opencode/skills/Bad_Name/SKILL.md': skill(`name: Bad_Name\ndescription: ${'x'.repeat(1100)}`, 'w '.repeat(20000)),
      '.github/skills/mismatch/SKILL.md': skill('name: other-name\ndescription: folder name differs'),
      'skills/off/SKILL.md': skill('name: off\ndescription: disabled in front matter\nenabled: false'),
      'skills/gizli/SKILL.md': skill('name: gizli\ndescription: explicit only\ndisable-model-invocation: true'),
      'skills/always-on/SKILL.md': skill('name: always-on\ndescription: her zaman\nalways: true'),
      'skills/node_modules/x/SKILL.md': skill('name: ignored\ndescription: ignored'),
      'extra/one.md': skill('name: extra-one\ndescription: config path file'),
      'extra-dir/two/SKILL.md': skill('name: extra-two\ndescription: config path dir'),
    });
    const reg = SkillRegistry.discover(root, { home, extraPaths: ['extra/one.md', 'extra-dir', 'missing-dir'], disabled: ['USER-ONLY'] });
    const names = reg.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['Bad_Name', 'always-on', 'body-only', 'driver', 'extra-one', 'extra-two', 'gizli', 'legacy', 'nested-one', 'other-name', 'shared']);
    const driver = reg.get('driver')!;
    assert.equal(driver.format, 'folder');
    assert.equal(driver.source, '.kurultay/skills');
    assert.deepEqual(driver.files, ['references/api.md', 'scripts/gen.sh']);
    assert.deepEqual(driver.keywords, ['sürücü', 'driver']);
    assert.deepEqual(driver.paths, ['src/drivers/**']);
    assert.equal(driver.argumentHint, '<ad>');
    assert.deepEqual(driver.allowedTools, ['read_file', 'edit_file']);
    assert.equal(reg.get('legacy')!.format, 'file');
    assert.equal(reg.get('shared')!.description, 'project copy', 'project wins over home');
    assert.equal(reg.get('body-only')!.description, 'İlk satır açıklama olur');
    assert.equal(reg.get('extra-one')!.scope, 'config');
    assert.equal(reg.get('$driver'), driver);
    assert.equal(reg.get('/driver'), driver);
    assert.equal(reg.get('skill:DRIVER'), driver);
    const msgs = reg.diagnostics.map((d) => `${d.level}:${d.message}`).join('\n');
    assert.match(msgs, /error:description zorunlu/);
    assert.match(msgs, /küçük harf/);
    assert.match(msgs, /1024 karakteri aşıyor/);
    assert.match(msgs, /5000 altını/);
    assert.match(msgs, /klasör adıyla/);
    assert.match(msgs, /"shared" adı çakışıyor/);
    assert.match(msgs, /skill yolu bulunamadı/);
    assert.ok(!reg.visible().some((s) => s.name === 'gizli'));
    assert.equal(SkillRegistry.empty().size, 0);
    // user skills can be turned off; a home that IS the project is not scanned twice
    assert.ok(!SkillRegistry.discover(root, { home, includeUser: false }).get('user-only'));
    assert.ok(SkillRegistry.discover(root, { home }).get('user-only'));
    const self = SkillRegistry.discover(home, { home });
    assert.equal(self.size, 2);
    assert.equal(self.diagnostics.length, 0, 'home used as project is scanned once');
  });

  it('de-duplicates symlinked skills and follows symlinked folders', (t) => {
    const root = tmpProject({ 'shared-skills/linked/SKILL.md': skill('name: linked\ndescription: via symlink') });
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    try {
      symlinkSync(join(root, 'shared-skills', 'linked'), join(root, '.agents', 'skills', 'linked'), 'dir');
      symlinkSync(join(root, 'shared-skills', 'linked'), join(root, '.claude', 'skills', 'linked'), 'dir');
      symlinkSync(join(root, 'nowhere'), join(root, '.claude', 'skills', 'dangling'), 'dir');
    } catch {
      t.skip('symlinks not permitted');
      return;
    }
    const reg = SkillRegistry.discover(root, { includeUser: false });
    assert.equal(reg.skills.filter((s) => s.name === 'linked').length, 1);
    assert.ok(!reg.diagnostics.some((d) => /çakışıyor/.test(d.message)), 'same physical file is not a collision');
  });
});

describe('skill selection and rendering', () => {
  const root = tmpProject({
    '.kurultay/skills/driver/SKILL.md': skill('name: driver\ndescription: Yeni donanım sürücüsü ekleme prosedürü\nkeywords: [sürücü]\npaths: ["src/drivers/**"]\nargument-hint: <ad>', 'Sürücü $ARGUMENTS için {{ args }} adımları'),
    '.kurultay/skills/driver/references/api.md': '# API kuralları',
    '.kurultay/skills/logging/SKILL.md': skill('name: logging\ndescription: Log formatı kuralları'),
    '.kurultay/skills/always-on/SKILL.md': skill('name: always-on\ndescription: genel kurallar\nalways: true'),
    '.kurultay/skills/gizli/SKILL.md': skill('name: gizli\ndescription: gizli <iş> & "özel"\ndisable-model-invocation: true'),
    '.kurultay/skills/c-only/SKILL.md': skill('name: c-only\ndescription: yalnız C dosyaları\nalways: true\npaths: ["**/*.c"]'),
  });
  const reg = SkillRegistry.discover(root, { includeUser: false });

  it('matches paths, $mentions and keyword triggers', () => {
    const driver = reg.get('driver')!;
    assert.equal(SkillRegistry.matchesFiles(driver, ['src/drivers/uart.c']), true);
    assert.equal(SkillRegistry.matchesFiles(driver, ['src/app.c']), false);
    assert.equal(SkillRegistry.matchesFiles(reg.get('logging')!, []), true);
    assert.deepEqual(reg.mentioned('use $logging and ($driver) and $missing, $logging again').map((s) => s.name), ['logging', 'driver']);
    assert.deepEqual(reg.triggered('Yeni SÜRÜCÜ yaz').map((s) => s.name), ['driver']);
    assert.deepEqual(reg.triggered('yüksürücü'), [], 'keywords match at word starts only');
    assert.ok(reg.score(driver, 'donanım sürücüsü eklemek istiyorum') >= 0.25);
    assert.equal(reg.score(driver, ''), 0);
  });

  it('selects preload in priority order and recommends lexically', () => {
    const sel = selectSkillsFor(reg, { text: 'sürücü ekle, $logging kullan', files: ['src/drivers/spi.c'], explicit: ['gizli', 'unknown'], planned: ['driver', 'logging', 'nope'], maxPreload: 3 });
    assert.deepEqual(sel.preload.map((s) => s.name), ['gizli', 'logging', 'always-on', 'c-only', 'driver']);
    assert.equal(sel.reasons.gizli, 'açıkça seçildi');
    assert.equal(sel.reasons.logging, '$ ile anıldı');
    assert.equal(sel.reasons['always-on'], 'always');
    const planned = selectSkillsFor(reg, { text: 'başka iş', files: ['README.md'], planned: ['logging', 'gizli'] });
    assert.deepEqual(planned.preload.map((s) => s.name), ['always-on', 'logging'], 'hidden skills are never planner-selected');
    assert.equal(planned.reasons.logging, 'planlayıcı seçti');
    const rec = selectSkillsFor(reg, { text: 'log formatı kuralları nedir', files: [] });
    assert.deepEqual(rec.recommended, ['logging']);
  });

  it('renders the catalogue, bodies with arguments and supporting files', () => {
    const cat = reg.catalogue({ files: ['src/app.js'], exclude: ['always-on'], recommended: ['logging'] });
    assert.match(cat, /<available_skills>/);
    assert.match(cat, /<skill><name>logging<\/name><description>Log formatı kuralları<\/description><\/skill>/);
    assert.match(cat, /Recommended for this task: logging/);
    assert.ok(!cat.includes('driver'), 'path-conditional skill hidden for unrelated files');
    assert.ok(!cat.includes('gizli'));
    assert.ok(!cat.includes('always-on'));
    assert.match(reg.catalogue(), /<arguments>&lt;ad&gt;<\/arguments>/);
    assert.equal(SkillRegistry.empty().catalogue(), '');
    const body = reg.render(reg.get('driver')!, 'uart');
    assert.match(body, /^<skill name="driver" source=".kurultay\/skills">/);
    assert.match(body, /Sürücü uart için uart adımları/);
    assert.match(body, /- references\/api\.md/);
    assert.ok(!body.includes('keywords:'), 'front matter stripped');
    assert.match(reg.readFile(reg.get('driver')!, 'references/api.md'), /API kuralları/);
    assert.throws(() => reg.readFile(reg.get('driver')!, '../logging/SKILL.md'), /dışındaki yol/);
    assert.throws(() => reg.readFile(reg.get('driver')!, 'references/none.md'), /skill dosyası yok: .*references\/api\.md/);
    assert.throws(() => reg.readFile(reg.get('logging')!, 'x.md'), /Mevcut: -/);
    const tpl = SKILL_TEMPLATE('yeni-is', 'Yeni iş açıklaması');
    assert.match(tpl, /^---\nname: yeni-is\ndescription: Yeni iş açıklaması\n/);
    assert.equal(parseFrontmatter(tpl).data.name, 'yeni-is');
  });

  it('exposes skill and skill_file tools only when skills exist', async () => {
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] });
    const index = new ProjectIndex(root, join(root, '.kurultay'));
    index.build();
    const events: string[] = [];
    const ctx: ToolContext = {
      workerId: 'w',
      root,
      overlay: new Overlay('w', root),
      index,
      materializer: new Materializer(root, join(root, '.kurultay')),
      config: cfg,
      skills: reg,
      loadedSkills: new Set(),
      explicitSkills: new Set(),
      bus: { emitEvent: (t: string) => events.push(t) } as unknown as ToolContext['bus'],
    };
    assert.ok(toolSpecs(undefined, { skills: true }).some((t) => t.function.name === 'skill'));
    assert.ok(!toolSpecs(undefined, { skills: false }).some((t) => t.function.name === 'skill'));
    assert.ok(!toolCatalogue(undefined, { skills: false }).includes('skill_file'));
    const loaded = await executeTool('skill', { name: 'driver', args: 'spi' }, ctx);
    assert.match(loaded.output, /Sürücü spi için/);
    assert.deepEqual(events, ['skill.load']);
    assert.match((await executeTool('skill', { name: 'driver' }, ctx)).output, /zaten yüklü/);
    const missing = await executeTool('skill', { name: 'nope' }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.output, /Mevcut skill'ler: .*logging/);
    const hidden = await executeTool('skill', { name: 'gizli' }, ctx);
    assert.equal(hidden.isError, true);
    ctx.explicitSkills!.add('gizli');
    assert.match((await executeTool('skill', { name: 'gizli' }, ctx)).output, /<skill name="gizli"/);
    assert.match((await executeTool('skill_file', { name: 'driver', path: 'references/api.md' }, ctx)).output, /^driver\/references\/api\.md\n# API/);
    assert.equal((await executeTool('skill_file', { name: 'nope', path: 'x' }, ctx)).isError, true);
    assert.equal((await executeTool('skill_file', { name: 'driver', path: '../../x' }, ctx)).isError, true);
    const none = await executeTool('skill', { name: 'driver' }, { ...ctx, skills: SkillRegistry.empty() });
    assert.match(none.output, /skill yok/);
  });
});

describe('skill files on disk', () => {
  it('reads CRLF SKILL.md files', () => {
    const root = tmpProject({});
    mkdirSync(join(root, '.agents', 'skills', 'crlf'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'crlf', 'SKILL.md'), '---\r\nname: crlf\r\ndescription: windows line endings\r\n---\r\nBody\r\n');
    const reg = SkillRegistry.discover(root, { includeUser: false });
    assert.equal(reg.get('crlf')?.description, 'windows line endings');
    assert.match(reg.render(reg.get('crlf')!), /Body/);
  });
});
