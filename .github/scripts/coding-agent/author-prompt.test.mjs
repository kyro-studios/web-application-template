import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { buildCreatePrompt, buildFixPrompt, promptFiles } from './author-prompt.mjs';
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
  stage: /** @type {import('./agent-request.mjs').AgentStage} */ ('specification'),
  issueNumber: 3,
  targetSha: '0123456789abcdef0123456789abcdef01234567',
};

describe('buildCreatePrompt', () => {
  it('指示のファイルの本文と、依頼の内容をつなげる', () => {
    const prompt = buildCreatePrompt({
      prompts: ['共通の指示\n', '文書の指示\n', '仕様書の指示\n'],
      request: { ...baseRequest, mode: 'create', pullRequestNumber: null, materials },
    });

    assert.match(prompt, /^共通の指示\n\n文書の指示\n\n仕様書の指示\n\n## 依頼の内容/);
    assert.match(prompt, /- 作成する成果物: `docs\/features\/1-login\/specification\.md`/);
    assert.match(prompt, /  - 要件定義: `docs\/features\/1-login\/requirements\.md`/);
    assert.match(prompt, /- 変更してよいファイル: `docs\/features\/1-login\/specification\.md`/);
    assert.doesNotMatch(prompt, /変更してはいけないファイル/);
    assert.match(prompt, /### 機能の親 Issue の本文\n\n~~~~text\n```\nログインする\n```\n~~~~/);
  });

  it('実装計画では、変更してよいファイルの代わりに、担当に選べるエージェントと上限を書く', () => {
    const prompt = buildCreatePrompt({
      prompts: ['共通の指示', '計画の指示'],
      request: {
        ...baseRequest,
        mode: 'create',
        stage: 'planning',
        pullRequestNumber: null,
        materials: {
          ...materials,
          artifact: null,
          allowedFiles: null,
          implementers: [{ id: 'claude', name: 'Claude Code' }],
          planLimits: { maxTasks: 30, maxDepth: 6 },
        },
      },
    });

    assert.doesNotMatch(prompt, /変更してよいファイル/);
    assert.doesNotMatch(prompt, /作成する成果物/);
    assert.match(prompt, /- 実装タスクの担当に選べるエージェント: `claude` \(Claude Code\)/);
    assert.match(prompt, /- タスクの数の上限: 30 件/);
    assert.match(prompt, /- 親子関係の深さの上限: 6 階層/);
  });
});

describe('buildFixPrompt', () => {
  it('修正の指示に、レビューの所見と行への指摘、修正の回数を含める', () => {
    const prompt = buildFixPrompt({
      prompts: ['修正の指示\n', '仕様書の指示\n'],
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

describe('promptFiles', () => {
  it('依頼の種類と段階の種類ごとに、読み込む指示のファイルを決める', () => {
    assert.deepEqual(promptFiles('create', 'specification'), ['create/common.md', 'create/documents.md', 'create/specification.md']);
    assert.deepEqual(promptFiles('create', 'planning'), ['create/common.md', 'create/planning.md']);
    assert.deepEqual(promptFiles('fix', 'architecture'), ['fix/common.md', 'create/architecture.md']);
  });

  it('起動できる段階で読み込む指示のファイルが、すべてある', async () => {
    const promptsDir = new URL('../../coding-agent/prompts/', import.meta.url);
    const files = new Set([
      ...(await readdir(new URL('create/', promptsDir))).map((file) => `create/${file}`),
      ...(await readdir(new URL('fix/', promptsDir))).map((file) => `fix/${file}`),
    ]);
    for (const stage of CREATABLE_STAGES) {
      for (const file of promptFiles('create', stage)) {
        assert.ok(files.has(file), file);
      }
    }
    assert.ok(files.has('fix/common.md'));
  });
});
