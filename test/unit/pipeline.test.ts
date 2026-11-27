import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectPipelineVerify, verifyFromPipeline } from '../../src/orchestrator/pipeline.js';
import { detectVerifyCommands } from '../../src/orchestrator/verify.js';
import { parseYaml } from '../../src/orchestrator/yaml.js';
import { createApp } from '../../src/app.js';
import { EventBus } from '../../src/util/events.js';
import { tmpProject } from '../helpers.js';

const GITLAB = `
variables:
  MAVEN_CLI_OPTS: "--batch-mode -s ci_settings.xml"   # the CI settings
stages: [build, test, deploy]
.mvn: &mvn
  image: maven:3.8-openjdk-11
  before_script:
    - echo start
build:
  <<: *mvn
  stage: build
  script:
    - cd gui
    - mvn $MAVEN_CLI_OPTS -DskipTests package
unit-tests:
  extends: .mvn
  stage: test
  script: |
    cd gui
    mvn $MAVEN_CLI_OPTS test \\
      -Dtest=All
    echo done
deploy:
  stage: deploy
  script:
  - mvn deploy
docker:
  stage: build
  script:
    - docker build -t app .
`;

describe('YAML reader (pipeline files)', () => {
  it('reads maps, lists, scalars, block texts, flow lists, anchors, merges and comments', () => {
    const doc = parseYaml(`
# a comment
---
name: "quoted: # not a comment"
other: 'it''s'
num: 12
yes: true
none: ~
empty:
list: [a, 'b, c', [d]]
lit: |
  line one
    indented
  line three
fold: >-
  folded
  text
keep: |+
  kept

base: &b
  x: 1
  y: 2
merged:
  <<: *b
  y: 3
alias: *b
tagged: !reference [.x, script]
"key with space": v
seq:
- one
-   two
- k: v
  k2: v2
nested:
  - - inner
plain: first
  continued
`) as Record<string, unknown>;
    assert.equal(doc.name, 'quoted: # not a comment');
    assert.equal(doc.other, "it's");
    assert.equal(doc.num, 12);
    assert.equal(doc.yes, true);
    assert.equal(doc.none, null);
    assert.equal(doc.empty, null);
    assert.deepEqual(doc.list, ['a', 'b, c', ['d']]);
    assert.equal(doc.lit, 'line one\n  indented\nline three\n');
    assert.equal(doc.fold, 'folded text');
    assert.equal(doc.keep, 'kept');
    assert.deepEqual(doc.merged, { x: 1, y: 3 });
    assert.deepEqual(doc.alias, { x: 1, y: 2 });
    assert.deepEqual(doc.tagged, ['.x', 'script']);
    assert.equal(doc['key with space'], 'v');
    assert.deepEqual(doc.seq, ['one', 'two', { k: 'v', k2: 'v2' }]);
    assert.deepEqual(doc.nested, [['inner']]);
    assert.equal(doc.plain, 'first continued');
    assert.equal(parseYaml(''), null);
    assert.deepEqual(parseYaml('- a\n- b'), ['a', 'b']);
  });
});

describe('Build and test commands from the CI pipeline', () => {
  it('GitLab: variables filled in, cd kept, deploy and container jobs left out', () => {
    assert.deepEqual(verifyFromPipeline(GITLAB, '.gitlab-ci.yml', 'linux'), {
      build: 'cd gui && mvn --batch-mode -s ci_settings.xml -DskipTests package',
      test: 'cd gui && mvn --batch-mode -s ci_settings.xml test -Dtest=All',
      source: '.gitlab-ci.yml',
    });
  });

  it('GitHub workflows, Azure Pipelines (Maven/Gradle tasks), Bitbucket, Drone', () => {
    const gh = `
on: [push]
env:
  BUILD_TYPE: Release
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y ninja-build
      - name: Configure
        run: cmake -S . -B build -DCMAKE_BUILD_TYPE=\${{env.BUILD_TYPE}}
      - name: Build
        run: cmake --build build --config \${{ env.BUILD_TYPE }}
      - name: Test
        working-directory: build
        run: ctest -C $BUILD_TYPE
      - name: Publish
        run: gh release upload v1 build/app
  docs:
    steps:
      - run: make html
`;
    assert.deepEqual(verifyFromPipeline(gh, 'ci.yml', 'linux'), { build: 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release', test: 'cd build && ctest -C Release', source: 'ci.yml' });
    const az = `
variables:
  pom: app/pom.xml
steps:
- task: Maven@3
  inputs:
    mavenPomFile: 'app/pom.xml'
    goals: 'verify'
- task: Gradle@2
  inputs:
    tasks: 'assemble'
- script: ./gradlew compileJava -Pv=$(Build.BuildId)
  displayName: needs a pipeline value
`;
    assert.deepEqual(verifyFromPipeline(az, 'azure-pipelines.yml', 'win32'), { build: 'gradlew assemble', test: 'mvn -f app/pom.xml verify', source: 'azure-pipelines.yml' });
    const bb = 'pipelines:\n  default:\n    - step:\n        name: Build and test\n        script:\n          - npm ci\n          - npm run build\n          - npm test\n          - npm publish\n';
    assert.deepEqual(verifyFromPipeline(bb, 'bitbucket-pipelines.yml', 'linux'), { build: 'npm run build', test: 'npm test', source: 'bitbucket-pipelines.yml' });
    const drone = 'kind: pipeline\nsteps:\n- name: test\n  commands:\n  - go build ./...\n  - go test ./...\n';
    assert.deepEqual(verifyFromPipeline(drone, '.drone.yml', 'linux'), { build: 'go build ./...', test: 'go test ./...', source: '.drone.yml' });
    // nothing usable
    assert.equal(verifyFromPipeline('deploy:\n  script:\n    - ./deploy.sh\n', 'x.yml'), undefined);
    assert.equal(verifyFromPipeline('stages: [a]\n', 'x.yml'), undefined);
  });

  it('the project is checked with the pipeline when verify is empty; kurultay init writes them; fromPipeline: false turns it off', async () => {
    const root = tmpProject({ '.github/workflows/ci.yml': 'jobs:\n  b:\n    steps:\n      - run: make\n      - run: make test\n', 'pom.xml': '<project/>' });
    assert.deepEqual(detectPipelineVerify(root), { build: 'make', test: 'make test', source: '.github/workflows/ci.yml' });
    assert.equal(detectPipelineVerify(tmpProject({ 'a.txt': '' })), undefined);
    // kurultay init: the pipeline beats the guess from pom.xml
    assert.deepEqual({ b: detectVerifyCommands(root).build, t: detectVerifyCommands(root).test }, { b: 'make', t: 'make test' });
    const cfg = (extra: Record<string, unknown> = {}) => JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] }], ...extra });
    const bus = new EventBus();
    const app = await createApp({ root, config: join(tmpProject({ 'c.json': cfg() }), 'c.json'), bus, requireModels: false, learn: false });
    assert.equal(app.verifyFrom, '.github/workflows/ci.yml');
    assert.deepEqual([app.config.verify.build, app.config.verify.test], ['make', 'make test']);
    assert.ok(bus.history.some((e) => e.type === 'log.info' && /build\/test commands from \.github\/workflows\/ci\.yml: build `make` · test `make test`/.test(e.message ?? '')));
    // configured commands win; fromPipeline: false keeps them empty
    const own = await createApp({ root, config: join(tmpProject({ 'c.json': cfg({ verify: { test: 'ctest' } }) }), 'c.json'), requireModels: false, learn: false });
    assert.deepEqual([own.config.verify.build ?? '', own.config.verify.test, own.verifyFrom], ['', 'ctest', undefined]);
    const off = await createApp({ root, config: join(tmpProject({ 'c.json': cfg({ verify: { fromPipeline: false } }) }), 'c.json'), requireModels: false, learn: false });
    assert.equal(off.verifyFrom, undefined);
  });
});
