import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { buildCreatePrompt, buildFixPrompt } from './author-prompt.mjs';
import { CREATABLE_STAGES } from './handlers/launch-stage.mjs';

const materials = {
  issue: { number: 3, title: '仕様書: ログイン', body: '仕様書を作る' },
  feature: { number: 1, title: 'ログイン', body: '```\nログインする\n```' },
  featureDir: 'docs/features/1-login',
  artifact: 'docs/features/1-login/specification.md',
  documents: [{ name: '要件定義', path: 'docs/features/1-login/requirements.md' }],
  allowedFiles: { allow: ['docs/features/1-login/specification.md'], deny: [] },
};

const baseRequest = {
  id: 'create-issue-3',
  agent: 'claude',
  stage: /** @type {const} */ ('specification'),
  issueNumber: 3,
  targetSha: '0123456789abcdef0123456789abcdef01234567',
};

describe('buildCreatePrompt', () => {
  it('共通の指示、段階ごとの指示、依頼の内容をつなげる', () => {
    const prompt = buildCreatePrompt({
      common: '共通の指示\n',
      stagePrompt: '仕様書の指示\n',
      request: { ...baseRequest, mode: 'create', pullRequestNumber: null, materials },
    });

    assert.match(prompt, /^共通の指示\n\n仕様書の指示\n\n## 依頼の内容/);
    assert.match(prompt, /- 作成する成果物: `docs\/features\/1-login\/specification\.md`/);
    assert.match(prompt, /  - 要件定義: `docs\/features\/1-login\/requirements\.md`/);
    assert.match(prompt, /- 変更してよいファイル: `docs\/features\/1-login\/specification\.md`/);
    assert.doesNotMatch(prompt, /変更してはいけないファイル/);
    assert.match(prompt, /### 機能の親 Issue の本文\n\n~~~~text\n```\nログインする\n```\n~~~~/);
  });
});

describe('buildFixPrompt', () => {
  it('修正の指示に、レビューの所見と行への指摘、修正の回数を含める', () => {
    const prompt = buildFixPrompt({
      common: '修正の指示\n',
      stagePrompt: '仕様書の指示\n',
      request: {
        ...baseRequest,
        id: 'fix-pr-8-0123456',
        mode: 'fix',
        pullRequestNumber: 8,
        materials: {
          ...materials,
          pullRequest: { number: 8, title: 'docs: 仕様書を追加する', body: 'Closes #3', headRef: 'coding-agent/claude/issue-3-1' },
          review: { id: 1, body: '所見', comments: [{ path: 'docs/features/1-login/specification.md', line: 12, body: '要件が漏れている' }] },
          fixRound: 2,
          maxFixRounds: 3,
        },
      },
    });

    assert.match(prompt, /^修正の指示\n\n## 参考: この段階の成果物に求められること\n\n仕様書の指示/);
    assert.match(prompt, /- PR: #8 docs: 仕様書を追加する/);
    assert.match(prompt, /- 修正の回数: 2 回目 \(上限 3 回\)/);
    assert.match(prompt, /- 修正する成果物: `docs\/features\/1-login\/specification\.md`/);
    assert.match(prompt, /### レビューの所見\n\n~~~text\n所見\n~~~/);
    assert.match(prompt, /- `docs\/features\/1-login\/specification\.md` の 12 行目:\n\n~~~text\n要件が漏れている\n~~~/);
  });
});

describe('作成担当への指示のファイル', () => {
  it('起動できる段階ごとの作成の指示と、作成と修正に共通する指示がある', async () => {
    const createFiles = await readdir(new URL('../../coding-agent/prompts/create/', import.meta.url));
    for (const stage of ['common', ...CREATABLE_STAGES]) {
      assert.ok(createFiles.includes(`${stage}.md`), stage);
    }
    const fixFiles = await readdir(new URL('../../coding-agent/prompts/fix/', import.meta.url));
    assert.ok(fixFiles.includes('common.md'));
  });
});
