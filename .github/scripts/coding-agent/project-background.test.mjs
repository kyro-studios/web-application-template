import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  PROJECT_BACKGROUND_PATH,
  projectBackgroundFor,
  projectBackgroundLines,
  readProjectBackground,
  receivesProjectBackground,
  stripBackgroundGuide,
} from './project-background.mjs';
import { FEATURE_STAGES, IMPLEMENTATION_STAGE } from './stages.mjs';

describe('receivesProjectBackground', () => {
  it('仕様の 6.6 の表のとおり、概念モデルのほかのすべての段階に背景を渡す', () => {
    const stages = [...FEATURE_STAGES.map((stage) => stage.id), IMPLEMENTATION_STAGE];
    assert.deepEqual(
      stages.filter((stage) => !receivesProjectBackground(stage)),
      ['domain-model'],
    );
  });
});

describe('stripBackgroundGuide', () => {
  it('書き方の説明 (HTML のコメント) を除く', () => {
    assert.equal(stripBackgroundGuide('# 背景\n\n<!-- 説明\n複数行 -->\n\n## 方針\n\nC > D > Q\n'), '# 背景\n\n## 方針\n\nC > D > Q');
  });

  it('見出しのほかに何も書かれていなければ、書かれていないものとして扱う', () => {
    assert.equal(stripBackgroundGuide('# 背景\n\n<!-- 説明 -->\n\n## 方針\n\n<!-- 例 -->\n'), null);
    assert.equal(stripBackgroundGuide(''), null);
    assert.equal(stripBackgroundGuide(null), null);
  });

  it('テンプレートの docs/project.md は、まだ書かれていないものとして扱う', async () => {
    const template = await readFile(new URL(`../../../${PROJECT_BACKGROUND_PATH}`, import.meta.url), 'utf8');
    assert.equal(stripBackgroundGuide(template), null);
  });
});

describe('projectBackgroundLines', () => {
  it('背景の見出しを 2 段下げて、「プロジェクトの背景」の節にする', () => {
    const lines = projectBackgroundLines('# プロジェクトの背景\n\n## 方針\n\nC > D > Q');
    assert.equal(lines[0], '## プロジェクトの背景');
    const text = lines.join('\n');
    assert.match(text, /### プロジェクトの背景\n\n#### 方針\n\nC > D > Q\n$/);
  });

  it('背景が書かれていなければ、機能の事情だけで判断するよう伝える', () => {
    assert.match(projectBackgroundLines(null).join('\n'), /まだ書かれていません。機能の親 Issue と要件定義書に書かれた事情だけを頼りに判断し/);
  });

  it('背景を渡さない段階 (undefined) では、節を加えない', () => {
    assert.deepEqual(projectBackgroundLines(undefined), []);
  });
});

describe('projectBackgroundFor', () => {
  /** @type {string} */
  let workspace;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'project-background-'));
    await mkdir(join(workspace, 'docs'));
    await writeFile(join(workspace, PROJECT_BACKGROUND_PATH), '# 背景\n\n<!-- 説明 -->\n\n## 方針\n\nC > D > Q\n');
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('作業ディレクトリから読み、書き方の説明を除く', async () => {
    assert.equal(await projectBackgroundFor('specification', workspace), '# 背景\n\n## 方針\n\nC > D > Q');
  });

  it('概念モデルには渡さない', async () => {
    assert.equal(await projectBackgroundFor('domain-model', workspace), undefined);
  });

  it('ファイルが無ければ null を返す', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'project-background-empty-'));
    try {
      assert.equal(await readProjectBackground(empty), null);
      assert.equal(await projectBackgroundFor('architecture', empty), null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
