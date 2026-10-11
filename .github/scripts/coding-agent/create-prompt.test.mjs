import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { buildCreatePrompt } from './create-prompt.mjs';
import { CREATABLE_STAGES } from './handlers/launch-stage.mjs';

describe('buildCreatePrompt', () => {
  it('共通の指示、段階ごとの指示、依頼の内容をつなげる', () => {
    const prompt = buildCreatePrompt({
      common: '共通の指示\n',
      stagePrompt: '仕様書の指示\n',
      request: {
        id: 'create-issue-3',
        agent: 'claude',
        mode: 'create',
        stage: 'specification',
        issueNumber: 3,
        pullRequestNumber: null,
        targetSha: '0123456789abcdef0123456789abcdef01234567',
        materials: {
          issue: { number: 3, title: '仕様書: ログイン', body: '仕様書を作る' },
          feature: { number: 1, title: 'ログイン', body: '```\nログインする\n```' },
          featureDir: 'docs/features/1-login',
          artifact: 'docs/features/1-login/specification.md',
          documents: [{ name: '要件定義', path: 'docs/features/1-login/requirements.md' }],
          allowedFiles: { allow: ['docs/features/1-login/specification.md'], deny: [] },
        },
      },
    });

    assert.match(prompt, /^共通の指示\n\n仕様書の指示\n\n## 依頼の内容/);
    assert.match(prompt, /- 作成する成果物: `docs\/features\/1-login\/specification\.md`/);
    assert.match(prompt, /  - 要件定義: `docs\/features\/1-login\/requirements\.md`/);
    assert.match(prompt, /- 変更してよいファイル: `docs\/features\/1-login\/specification\.md`/);
    assert.doesNotMatch(prompt, /変更してはいけないファイル/);
    assert.match(prompt, /### 機能の親 Issue の本文\n\n~~~~text\n```\nログインする\n```\n~~~~/);
  });
});

describe('作成の指示のファイル', () => {
  it('起動できる段階ごとに、指示のファイルがある', async () => {
    const files = await readdir(new URL('../../coding-agent/prompts/create/', import.meta.url));
    for (const stage of ['common', ...CREATABLE_STAGES]) {
      assert.ok(files.includes(`${stage}.md`), stage);
    }
  });
});
