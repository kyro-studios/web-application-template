import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { FIX_MARKER, fixRequestMarker, maxFixRounds, requestFix } from './request-fix.mjs';

const config = fixtureConfig();
const HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const OLD_SHA = '0123456789abcdef0123456789abcdef01234567';
const PR_NUMBER = 100;

/**
 * 機能の親 Issue と、仕様書の段階の Issue と、それを Close する Claude の PR を用意する。
 *
 * @param {object} [options]
 * @param {string} [options.author] PR の作成者
 * @param {{ state: string, commit_id: string }[]} [options.reviews] レビュー担当のレビュー (古いものから)
 */
function setup({ author = 'claude-app[bot]', reviews = [{ state: 'CHANGES_REQUESTED', commit_id: HEAD_SHA }] } = {}) {
  const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions: { alice: 'write' } });
  const feature = fake.addIssue({
    title: 'ログイン機能',
    body: '### 機能名\n\nuser-login\n\n### 概要\n\nログインする',
    labels: ['feature'],
    user: 'alice',
  });
  const specification = fake.addIssue({ title: '仕様書: ログイン機能', labels: ['stage:specification'], parent: feature.number });
  fake.addPull(PR_NUMBER, {
    closing: [specification.number],
    detail: {
      state: 'open',
      draft: false,
      title: 'docs: 仕様書を追加する',
      body: `Closes #${specification.number}`,
      user: { login: author },
      head: { sha: HEAD_SHA, ref: 'coding-agent/claude/issue-2-1', repo: { full_name: 'kyro-studios/sandbox' } },
      base: { sha: OLD_SHA, ref: 'develop', repo: { full_name: 'kyro-studios/sandbox' } },
    },
    reviews: reviews.map((review, index) => ({
      id: index + 1,
      state: review.state,
      commit_id: review.commit_id,
      submitted_at: `2026-10-0${index + 1}T00:00:00Z`,
      body: `レビュー ${index + 1}`,
      user: { login: 'codex-app[bot]' },
    })),
    reviewComments: [{ pull_request_review_id: reviews.length, path: 'docs/features/1-user-login/specification.md', line: 3, body: '行への指摘' }],
  });
  return { fake, feature, specification };
}

/**
 * @param {ReturnType<typeof setup>['fake']} fake
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {boolean} [options.force]
 */
async function run(fake, { number = PR_NUMBER, force = false } = {}) {
  const core = createFakeCore();
  const context = {
    eventName: 'workflow_dispatch',
    actor: 'github-actions[bot]',
    payload: { inputs: { 'issue-number': String(number), force }, repository: { default_branch: 'develop' } },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
  // @ts-expect-error テストに必要な部分だけを渡す
  const result = await requestFix.run({ github: fake.github, context, core, config });
  return { result, core };
}

describe('maxFixRounds', () => {
  it('Variables の値を使い、正しくなければ既定の 3 回にする', () => {
    assert.equal(maxFixRounds('5'), 5);
    assert.equal(maxFixRounds(' 0 '), 0);
    assert.equal(maxFixRounds(undefined), 3);
    assert.equal(maxFixRounds(''), 3);
    assert.equal(maxFixRounds('two'), 3);
    assert.equal(maxFixRounds('1.5'), 3);
  });
});

describe('requestFix', () => {
  /** @type {string | undefined} */
  let savedMax;

  beforeEach(() => {
    savedMax = process.env.REVIEW_MAX_FIX_ROUNDS;
    delete process.env.REVIEW_MAX_FIX_ROUNDS;
  });

  afterEach(() => {
    if (savedMax === undefined) {
      delete process.env.REVIEW_MAX_FIX_ROUNDS;
    } else {
      process.env.REVIEW_MAX_FIX_ROUNDS = savedMax;
    }
  });

  it('今の head に対する差し戻しの修正を、PR を作ったエージェントに依頼し、依頼済みの印を残す', async () => {
    const { fake, specification } = setup();

    const { result } = await run(fake);

    assert.equal(result.requests?.length, 1);
    const request = result.requests[0];
    assert.equal(request.id, `fix-pr-${PR_NUMBER}-abcdef0`);
    assert.equal(request.agent, 'claude');
    assert.equal(request.mode, 'fix');
    assert.equal(request.stage, 'specification');
    assert.equal(request.issueNumber, specification.number);
    assert.equal(request.pullRequestNumber, PR_NUMBER);
    assert.equal(request.targetSha, HEAD_SHA);
    // 修正は、PR を作ったエージェントの修正のモデルと effort で行う
    assert.deepEqual(request.execution, { model: 'claude-fix-model', effort: 'low' });
    assert.equal(request.materials.pullRequest.headRef, 'coding-agent/claude/issue-2-1');
    assert.equal(request.materials.artifact, 'docs/features/1-user-login/specification.md');
    assert.deepEqual(request.materials.review, {
      id: 1,
      body: 'レビュー 1',
      comments: [{ path: 'docs/features/1-user-login/specification.md', line: 3, body: '行への指摘' }],
    });
    assert.equal(request.materials.fixRound, 1);
    assert.equal(request.materials.maxFixRounds, 3);

    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].issue_number, PR_NUMBER);
    assert.ok(fake.comments[0].body.includes(fixRequestMarker(1)));
  });

  it('同じレビューの修正は二重に依頼せず、force を指定した手動実行では依頼し直す', async () => {
    const { fake } = setup();
    await run(fake);

    assert.deepEqual((await run(fake)).result, {});
    assert.equal((await run(fake, { force: true })).result.requests?.length, 1);
  });

  it('最新のレビューが差し戻しでないか、差し戻しの後に更新された PR は修正しない', async () => {
    assert.deepEqual(
      (await run(setup({ reviews: [{ state: 'CHANGES_REQUESTED', commit_id: OLD_SHA }, { state: 'APPROVED', commit_id: HEAD_SHA }] }).fake)).result,
      {},
    );
    assert.deepEqual((await run(setup({ reviews: [{ state: 'CHANGES_REQUESTED', commit_id: OLD_SHA }] }).fake)).result, {});
    assert.deepEqual((await run(setup({ reviews: [] }).fake)).result, {});
  });

  it('人が作った PR や、レビュー担当が作った PR は修正しない', async () => {
    assert.deepEqual((await run(setup({ author: 'alice' }).fake)).result, {});
    assert.deepEqual((await run(setup({ author: 'codex-app[bot]' }).fake)).result, {});
  });

  it('差し戻しは、その段階のレビュー担当のものだけを見る', async () => {
    // 仕様書のレビュー担当を claude にすると、codex の差し戻しでは修正しない
    const original = config.agents.roles.specification;
    config.agents.roles.specification = { author: { agent: 'codex' }, reviewer: { agent: 'claude' } };
    try {
      const { fake } = setup({ author: 'codex-app[bot]' });
      assert.deepEqual((await run(fake)).result, {});
    } finally {
      config.agents.roles.specification = original;
    }
  });

  it('PR でない番号は扱わない', async () => {
    const { fake, specification } = setup();
    assert.deepEqual((await run(fake, { number: specification.number })).result, {});
  });

  it('修正の回数が上限に達していたら、needs-human ラベルを付けて機能の作成者に引き継ぐ', async () => {
    const { fake } = setup();
    for (let round = 0; round < 3; round++) {
      fake.addComment(PR_NUMBER, 'claude-app[bot]', `修正しました\n\n${FIX_MARKER}`);
    }
    // エージェント以外の印は数えない
    fake.addComment(PR_NUMBER, 'alice', FIX_MARKER);

    const { result } = await run(fake);

    assert.deepEqual(result, {});
    const pull = fake.issues.get(PR_NUMBER);
    assert.deepEqual(pull?.labels.map((label) => label.name), ['needs-human']);
    assert.deepEqual(pull?.assignees.map((user) => user.login), ['alice']);
    assert.match(fake.comments.at(-1)?.body ?? '', /上限の 3 回に達した/);
  });

  it('needs-human ラベルが外された後は、修正の回数を数え直す', async () => {
    const { fake } = setup();
    process.env.REVIEW_MAX_FIX_ROUNDS = '1';
    fake.addComment(PR_NUMBER, 'claude-app[bot]', FIX_MARKER);
    await fake.github.rest.issues.addLabels({ issue_number: PR_NUMBER, labels: ['needs-human'] });
    await fake.github.rest.issues.removeLabel({ issue_number: PR_NUMBER, name: 'needs-human' });

    const { result } = await run(fake);

    assert.equal(result.requests?.[0].materials.fixRound, 1);
    assert.equal(result.requests?.[0].materials.maxFixRounds, 1);
  });
});

describe('修正の印', () => {
  it('共通の書き込みジョブが、修正の回数を数える印と同じ文字列をコメントに残す', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile(new URL('../../../workflows/coding-agent-publish.yml', import.meta.url), 'utf8');
    assert.ok(workflow.includes(FIX_MARKER));
  });
});
