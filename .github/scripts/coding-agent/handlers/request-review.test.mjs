import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { requestReview } from './request-review.mjs';

const config = fixtureConfig();
const HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PR_NUMBER = 100;

/**
 * 機能の親 Issue と段階の Issue を用意する。
 *
 * @param {Record<string, string>} [permissions]
 */
function setup(permissions = { alice: 'write' }) {
  const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions });
  const feature = fake.addIssue({
    title: 'ログイン機能',
    body: '### 機能名\n\nuser-login\n\n### 概要\n\nログインする',
    labels: ['feature'],
    user: 'alice',
  });
  /** @param {string} stage */
  const addStage = (stage, parent = feature.number) => fake.addIssue({ title: `${stage}: ログイン機能`, labels: [`stage:${stage}`], parent });
  return { fake, feature, addStage };
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.author]
 * @param {'User' | 'Bot'} [overrides.authorType]
 * @param {boolean} [overrides.draft]
 * @param {string[]} [overrides.labels]
 * @param {string} [overrides.headRepo]
 * @param {string} [overrides.base]
 */
function pullRequestPayload({ author = 'alice', authorType = 'User', draft = false, labels = [], headRepo = 'kyro-studios/sandbox', base = 'develop' } = {}) {
  return {
    number: PR_NUMBER,
    state: 'open',
    draft,
    title: 'docs: 要件定義書を追加する',
    body: 'Closes #2',
    user: { login: author, type: authorType },
    labels: labels.map((name) => ({ name })),
    head: { sha: HEAD_SHA, repo: { full_name: headRepo } },
    base: { sha: BASE_SHA, ref: base, repo: { full_name: 'kyro-studios/sandbox' } },
  };
}

/**
 * @param {string} action
 * @param {ReturnType<typeof pullRequestPayload>} pullRequest
 * @param {object} [extra]
 */
function createContext(action, pullRequest, extra = {}) {
  return {
    eventName: 'pull_request_target',
    payload: { action, pull_request: pullRequest, repository: { default_branch: 'develop' }, ...extra },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
}

/**
 * @param {ReturnType<typeof createFakeGitHub>} fake
 * @param {ReturnType<typeof createContext>} context
 */
async function run(fake, context) {
  const core = createFakeCore();
  // @ts-expect-error テストに必要な部分だけを渡す
  const result = await requestReview.run({ github: fake.github, context, core, config });
  return { requests: result.requests ?? [], core };
}

/**
 * @param {ReturnType<typeof createContext>} context
 */
function matches(context) {
  // @ts-expect-error テストに必要な部分だけを渡す
  return requestReview.matches({ context, config });
}

describe('requestReview.matches', () => {
  it('既定ブランチに向けた、このリポジトリのブランチからの PR をレビューの候補にする', async () => {
    assert.equal(await matches(createContext('opened', pullRequestPayload())), true);
    assert.equal(await matches(createContext('synchronize', pullRequestPayload())), true);
  });

  it('Draft、フォーク、既定ブランチ以外に向けた PR、needs-human の付いた PR は候補にしない', async () => {
    assert.equal(await matches(createContext('opened', pullRequestPayload({ draft: true }))), false);
    assert.equal(await matches(createContext('opened', pullRequestPayload({ headRepo: 'someone/sandbox' }))), false);
    assert.equal(await matches(createContext('opened', pullRequestPayload({ base: 'main' }))), false);
    assert.equal(await matches(createContext('opened', pullRequestPayload({ labels: ['needs-human'] }))), false);
  });

  it('ラベルが外されたときは、needs-human が外されたときだけ候補にする', async () => {
    assert.equal(await matches(createContext('unlabeled', pullRequestPayload(), { label: { name: 'needs-human' } })), true);
    assert.equal(await matches(createContext('unlabeled', pullRequestPayload(), { label: { name: 'bug' } })), false);
  });
});

describe('requestReview.run', () => {
  it('人が作った要件定義書の PR のレビューを、レビュー担当に依頼する', async () => {
    const { fake, addStage } = setup();
    const requirements = addStage('requirements');
    fake.addPull(PR_NUMBER, { closing: [requirements.number], files: [{ filename: 'docs/features/1-user-login/requirements.md' }] });

    const { requests } = await run(fake, createContext('opened', pullRequestPayload()));

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.id, `review-pr-${PR_NUMBER}-abcdef0`);
    assert.equal(request.agent, 'codex');
    assert.equal(request.mode, 'review');
    assert.equal(request.stage, 'requirements');
    assert.equal(request.issueNumber, requirements.number);
    assert.equal(request.pullRequestNumber, PR_NUMBER);
    assert.equal(request.targetSha, HEAD_SHA);
    assert.equal(request.materials.featureDir, 'docs/features/1-user-login');
    assert.equal(request.materials.artifact, 'docs/features/1-user-login/requirements.md');
    assert.deepEqual(request.materials.documents, []);
    assert.deepEqual(request.materials.violations, []);
    assert.deepEqual(request.materials.previousReviews, []);
  });

  it('範囲外のファイルと、レビュー担当のこれまでのレビューを依頼に含める', async () => {
    const { fake, addStage } = setup();
    addStage('requirements');
    const specification = addStage('specification');
    fake.addPull(PR_NUMBER, {
      closing: [specification.number],
      files: [{ filename: 'docs/features/1-user-login/specification.md' }, { filename: 'README.md' }],
      reviews: [
        { id: 1, state: 'CHANGES_REQUESTED', commit_id: BASE_SHA, submitted_at: '2026-10-11T00:00:00Z', body: '前回の指摘', user: { login: 'codex-app[bot]' } },
        { id: 2, state: 'COMMENTED', commit_id: BASE_SHA, submitted_at: '2026-10-11T00:00:00Z', body: '人のコメント', user: { login: 'alice' } },
      ],
      reviewComments: [
        { pull_request_review_id: 1, path: 'docs/features/1-user-login/specification.md', line: 3, body: '行への指摘' },
        { pull_request_review_id: 2, path: 'README.md', line: 1, body: '人の行へのコメント' },
      ],
    });

    const { requests } = await run(fake, createContext('synchronize', pullRequestPayload({ author: 'claude-app[bot]', authorType: 'Bot' })));

    const { materials } = requests[0];
    assert.deepEqual(materials.violations, ['README.md']);
    assert.deepEqual(materials.documents, [{ name: '要件定義', path: 'docs/features/1-user-login/requirements.md' }]);
    assert.deepEqual(
      materials.previousReviews.map((/** @type {{ body: string, comments: { body: string }[] }} */ review) => [review.body, review.comments.map((comment) => comment.body)]),
      [['前回の指摘', ['行への指摘']]],
    );
  });

  it('実装タスクの PR は、祖先の機能の親 Issue から機能ごとのディレクトリを決める', async () => {
    const { fake, addStage } = setup();
    const planning = addStage('planning');
    const parentTask = addStage('implementation', planning.number);
    const task = addStage('implementation', parentTask.number);
    fake.addPull(PR_NUMBER, { closing: [task.number], files: [{ filename: 'app/backend/App.java' }, { filename: 'docs/features/1-user-login/architecture.md' }] });

    const { requests } = await run(fake, createContext('opened', pullRequestPayload({ author: 'claude-app[bot]', authorType: 'Bot' })));

    const { materials } = requests[0];
    assert.equal(requests[0].stage, 'implementation');
    assert.equal(materials.artifact, null);
    assert.deepEqual(
      materials.documents.map((/** @type {{ path: string }} */ document) => document.path),
      [
        'docs/features/1-user-login/specification.md',
        'docs/features/1-user-login/domain-model.md',
        'docs/features/1-user-login/architecture.md',
        'docs/features/1-user-login/acceptance-criteria.json',
        'docs/architecture.md',
        'docs/api/openapi.yaml',
      ],
    );
    assert.deepEqual(materials.violations, ['docs/features/1-user-login/architecture.md']);
  });

  it('段階ごとのレビュー担当に、そのモデルと effort で依頼する', async () => {
    const { fake, addStage } = setup();
    fake.addPull(PR_NUMBER, { closing: [addStage('specification').number] });

    const [request] = (await run(fake, createContext('opened', pullRequestPayload({ author: 'claude-app[bot]', authorType: 'Bot' })))).requests;

    assert.equal(request.agent, 'codex');
    assert.deepEqual(request.execution, { model: 'codex-model', effort: 'medium' });
  });

  it('作成担当とレビュー担当を入れ替えた段階では、その段階のレビュー担当に依頼する', async () => {
    const original = config.agents.roles['domain-model'];
    config.agents.roles['domain-model'] = { author: { agent: 'codex' }, reviewer: { agent: 'claude', model: 'claude-review-model', effort: 'medium' } };
    try {
      const { fake, addStage } = setup();
      fake.addPull(PR_NUMBER, { closing: [addStage('domain-model').number] });

      const [request] = (await run(fake, createContext('opened', pullRequestPayload({ author: 'codex-app[bot]', authorType: 'Bot' })))).requests;
      assert.equal(request.agent, 'claude');
      assert.deepEqual(request.execution, { model: 'claude-review-model', effort: 'medium' });

      // その段階のレビュー担当が作った PR は、自分で Approve できないためレビューしない
      assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload({ author: 'claude-app[bot]', authorType: 'Bot' })))).requests, []);
    } finally {
      config.agents.roles['domain-model'] = original;
    }
  });

  it('レビュー担当が作った PR、書き込み権限の無い人や登録されていない Bot の PR はレビューしない', async () => {
    const { fake, addStage } = setup({ alice: 'write', bob: 'read' });
    fake.addPull(PR_NUMBER, { closing: [addStage('requirements').number] });

    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload({ author: 'codex-app[bot]', authorType: 'Bot' })))).requests, []);
    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload({ author: 'bob' })))).requests, []);
    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload({ author: 'dependabot[bot]', authorType: 'Bot' })))).requests, []);
  });

  it('段階の Issue を Close しない PR はレビューしない', async () => {
    const { fake, addStage } = setup();
    const humanIssue = fake.addIssue({ labels: ['stage:requirements'], user: 'alice' });

    fake.addPull(PR_NUMBER, { closing: [] });
    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload()))).requests, []);

    fake.addPull(PR_NUMBER, { closing: [humanIssue.number] });
    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload()))).requests, []);

    fake.addPull(PR_NUMBER, { closing: [addStage('planning').number] });
    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload()))).requests, []);
    assert.equal(fake.comments.length, 0);
  });

  it('複数の Issue を Close する PR は、作成時だけコメントで知らせる', async () => {
    const { fake, addStage } = setup();
    fake.addPull(PR_NUMBER, { closing: [addStage('requirements').number, addStage('specification').number] });

    assert.deepEqual((await run(fake, createContext('opened', pullRequestPayload()))).requests, []);
    assert.deepEqual((await run(fake, createContext('synchronize', pullRequestPayload()))).requests, []);

    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].issue_number, PR_NUMBER);
    assert.match(fake.comments[0].body, /複数の Issue/);
  });
});
