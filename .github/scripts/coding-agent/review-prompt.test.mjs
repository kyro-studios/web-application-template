import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fence } from './prompt-format.mjs';
import { buildReviewPrompt, violationReview } from './review-prompt.mjs';

/**
 * @param {Partial<import('./review-prompt.mjs').ReviewMaterials>} [overrides]
 */
function createRequest(overrides = {}) {
  return {
    id: 'review-pr-100-abcdef0',
    agent: 'codex',
    mode: /** @type {const} */ ('review'),
    stage: /** @type {const} */ ('specification'),
    issueNumber: 3,
    pullRequestNumber: 100,
    targetSha: 'abcdef0123456789abcdef0123456789abcdef01',
    materials: {
      pullRequest: { number: 100, title: 'docs: 仕様書', body: 'Closes #3', author: 'claude-app[bot]', baseSha: 'base123', headSha: 'head456' },
      issue: { number: 3, title: '仕様書: ログイン', body: '仕様書を作る' },
      feature: { number: 1, title: 'ログイン', body: 'ログインできるようにする' },
      featureDir: 'docs/features/1-login',
      artifact: 'docs/features/1-login/specification.md',
      documents: [{ name: '要件定義', path: 'docs/features/1-login/requirements.md' }],
      allowedFiles: { allow: ['docs/features/1-login/specification.md'], deny: [] },
      violations: [],
      previousReviews: [],
      ...overrides,
    },
  };
}

describe('fence', () => {
  it('文章の中のどの区切りよりも長い区切りで囲む', () => {
    assert.equal(fence('本文'), '~~~text\n本文\n~~~');
    assert.equal(fence('```js\ncode\n```\n~~~~'), '~~~~~text\n```js\ncode\n```\n~~~~\n~~~~~');
  });
});

describe('buildReviewPrompt', () => {
  it('共通の指示、段階ごとの観点、依頼の内容をつなげる', () => {
    const prompt = buildReviewPrompt({ request: createRequest(), common: '共通の指示\n', stagePrompt: '仕様書の観点\n' });

    assert.match(prompt, /^共通の指示\n\n仕様書の観点\n\n## 依頼の内容/);
    assert.match(prompt, /- 段階: 仕様書/);
    assert.match(prompt, /`git diff base123\.\.\.HEAD`/);
    assert.match(prompt, /- 成果物: `docs\/features\/1-login\/specification\.md`/);
    assert.match(prompt, /  - 要件定義: `docs\/features\/1-login\/requirements\.md`/);
    assert.match(prompt, /### PR の本文\n\n~~~text\nCloses #3\n~~~/);
    assert.doesNotMatch(prompt, /これまでのレビュー/);
    assert.doesNotMatch(prompt, /この段階の知識/);
  });

  it('作成担当と同じ知識を、段階ごとの観点の後に加える', () => {
    const prompt = buildReviewPrompt({
      request: createRequest({ artifact: 'docs/features/1-login/architecture.md', sharedArtifacts: ['docs/architecture.md'] }),
      common: '共通の指示\n',
      stagePrompt: '設計の観点\n',
      knowledge: [{ name: '全体の構成と API の契約の書き方', body: '## 全体の構成\n\n- 1 つの文書に書く\n' }],
    });

    assert.match(prompt, /設計の観点\n\n## この段階の知識\n\n### 全体の構成と API の契約の書き方\n\n##### 全体の構成\n\n- 1 つの文書に書く\n\n## 依頼の内容/);
    assert.match(prompt, /- あわせて書き足す文書: `docs\/architecture\.md`/);
  });

  it('作成担当と同じプロジェクトの背景を、知識の後に加える', () => {
    const prompt = buildReviewPrompt({
      request: createRequest(),
      common: '共通の指示\n',
      stagePrompt: '仕様書の観点\n',
      knowledge: [{ name: 'スコープの決め方', body: '方針に合わせる' }],
      projectBackground: '# 背景\n\n## 方針\n\nC > D > Q',
    });

    assert.match(prompt, /方針に合わせる\n\n## プロジェクトの背景\n\n.+\n\n### 背景\n\n#### 方針\n\nC > D > Q\n\n## 依頼の内容/);
  });

  it('背景を渡さない段階 (省略) では、背景の節を加えない', () => {
    const prompt = buildReviewPrompt({ request: createRequest(), common: '共通の指示\n', stagePrompt: '概念モデルの観点\n' });
    assert.doesNotMatch(prompt, /プロジェクトの背景/);
  });

  it('これまでのレビューがあれば、行へのコメントとあわせて載せる', () => {
    const prompt = buildReviewPrompt({
      request: createRequest({
        previousReviews: [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            commitId: 'abcdef0123',
            submittedAt: '2026-10-11T00:00:00Z',
            body: '前回の所見',
            comments: [{ path: 'docs/features/1-login/specification.md', line: 3, body: '行への指摘' }],
          },
        ],
      }),
      common: '',
      stagePrompt: '',
    });

    assert.match(prompt, /## これまでのレビュー/);
    assert.match(prompt, /### 2026-10-11T00:00:00Z \(CHANGES_REQUESTED、コミット abcdef0\)/);
    assert.match(prompt, /- `docs\/features\/1-login\/specification\.md` の 3 行目:\n\n~~~text\n行への指摘\n~~~/);
  });
});

describe('violationReview', () => {
  it('範囲外のファイルごとに must の指摘を作る', () => {
    const review = violationReview({
      stage: 'implementation',
      violations: ['.github/workflows/ci.yml', 'AGENTS.md'],
      allowedFiles: { allow: ['**'], deny: ['.github/**', 'AGENTS.md'] },
    });

    assert.match(review.summary, /「実装タスク」の PR で変更できないファイル/);
    assert.match(review.summary, /変更してはいけないファイル: `\.github\/\*\*`、`AGENTS\.md`/);
    assert.deepEqual(
      review.findings.map((finding) => [finding.severity, finding.path]),
      [
        ['must', '.github/workflows/ci.yml'],
        ['must', 'AGENTS.md'],
      ],
    );
  });
});
