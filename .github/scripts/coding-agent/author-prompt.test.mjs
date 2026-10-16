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

  it('段階に渡す知識を、指示の後に、見出しを下げて加える', () => {
    const prompt = buildCreatePrompt({
      prompts: ['共通の指示', '設計の指示'],
      knowledge: [{ name: '既定の技術スタック', body: '# 技術スタック\n\n## バックエンド\n\n- Javalin\n' }],
      request: {
        ...baseRequest,
        mode: 'create',
        stage: 'architecture',
        pullRequestNumber: null,
        materials: { ...materials, artifact: 'docs/features/1-login/architecture.md', sharedArtifacts: ['docs/architecture.md', 'docs/api/openapi.yaml'] },
      },
    });

    assert.match(prompt, /設計の指示\n\n## この段階の知識\n\n### 既定の技術スタック\n\n#### 技術スタック\n\n##### バックエンド\n\n- Javalin\n\n## 依頼の内容/);
    assert.match(prompt, /- あわせて書き足す文書 \(機能をまたいで使う。無ければ作る\): `docs\/architecture\.md`、`docs\/api\/openapi\.yaml`/);
  });

  it('知識の無い段階には、知識の節を加えない', () => {
    const prompt = buildCreatePrompt({
      prompts: ['共通の指示'],
      request: { ...baseRequest, mode: 'create', pullRequestNumber: null, materials },
    });
    assert.doesNotMatch(prompt, /この段階の知識/);
    assert.doesNotMatch(prompt, /あわせて書き足す文書/);
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

  it('修正でも、作成と同じ知識を、段階ごとの指示の後に加える', () => {
    const prompt = buildFixPrompt({
      prompts: ['修正の指示\n', 'プロジェクトの作成の指示\n'],
      knowledge: [{ name: 'プロジェクトの約束', body: '## 置き場所\n\n- app/ に置く\n' }],
      request: {
        ...baseRequest,
        id: 'fix-pr-8-0123456',
        mode: 'fix',
        stage: 'project',
        pullRequestNumber: 8,
        materials: {
          ...materials,
          artifact: null,
          pullRequest: { number: 8, title: 'build: 土台を作る', body: 'Closes #3', headRef: 'coding-agent/claude/issue-3-1' },
          review: { id: 1, body: '所見', comments: [] },
          conflict: null,
          fixRound: 1,
          maxFixRounds: 3,
        },
      },
    });

    assert.match(prompt, /プロジェクトの作成の指示\n\n## この段階の知識\n\n### プロジェクトの約束\n\n##### 置き場所\n\n- app\/ に置く\n\n## 依頼の内容/);
  });
});

describe('buildFixPrompt (コンフリクト)', () => {
  it('コンフリクトだけの修正では、解消の指示とコンフリクトしたファイルを含め、レビューの所見は含めない', () => {
    const prompt = buildFixPrompt({
      prompts: ['修正の指示\n', '仕様書の指示\n', 'コンフリクトの指示\n'],
      request: {
        ...baseRequest,
        id: 'fix-pr-8-0123456',
        mode: 'fix',
        pullRequestNumber: 8,
        materials: {
          ...materials,
          pullRequest: { number: 8, title: 'docs: 仕様書を追加する', body: 'Closes #3', headRef: 'coding-agent/claude/issue-3-1' },
          review: null,
          conflict: { baseSha: '0123456789abcdef0123456789abcdef01234567', files: ['docs/features/1-login/specification.md'] },
          fixRound: 1,
          maxFixRounds: 3,
        },
      },
    });

    assert.match(prompt, /^修正の指示\n\nコンフリクトの指示\n\n## 参考: この段階の成果物に求められること/);
    assert.match(prompt, /- 修正の理由: 既定ブランチとのコンフリクト\n/);
    assert.match(prompt, /### コンフリクトしたファイル\n\n- `docs\/features\/1-login\/specification\.md`/);
    assert.doesNotMatch(prompt, /レビューの所見/);
  });
});

describe('promptFiles', () => {
  it('依頼の種類と段階の種類ごとに、読み込む指示のファイルを決める', () => {
    assert.deepEqual(promptFiles('create', 'specification'), ['create/common.md', 'create/documents.md', 'create/specification.md']);
    assert.deepEqual(promptFiles('create', 'planning'), ['create/common.md', 'create/planning.md']);
    assert.deepEqual(promptFiles('create', 'implementation'), ['create/common.md', 'create/implementation.md', 'create/implementation-output.md']);
    assert.deepEqual(promptFiles('create', 'project'), ['create/common.md', 'create/code.md', 'create/project.md', 'create/project-output.md']);
    assert.deepEqual(promptFiles('fix', 'architecture'), ['fix/common.md', 'create/architecture.md']);
    // 修正では、作成のときの出力の指示を含めない
    assert.deepEqual(promptFiles('fix', 'implementation'), ['fix/common.md', 'create/implementation.md']);
    assert.deepEqual(promptFiles('fix', 'project'), ['fix/common.md', 'create/project.md']);
    // コンフリクトの修正では、解消の指示を加える
    assert.deepEqual(promptFiles('fix', 'implementation', { conflict: true }), ['fix/common.md', 'create/implementation.md', 'fix/conflict.md']);
  });

  it('起動できる段階で読み込む指示のファイルが、すべてある', async () => {
    const promptsDir = new URL('../../coding-agent/prompts/', import.meta.url);
    const files = new Set([
      ...(await readdir(new URL('create/', promptsDir))).map((file) => `create/${file}`),
      ...(await readdir(new URL('fix/', promptsDir))).map((file) => `fix/${file}`),
    ]);
    for (const stage of CREATABLE_STAGES) {
      for (const file of [...promptFiles('create', stage), ...(stage === 'planning' ? [] : promptFiles('fix', stage, { conflict: true }))]) {
        assert.ok(files.has(file), file);
      }
    }
  });
});
