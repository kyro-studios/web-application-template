import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assignmentMarker, formatCriteriaFile } from '../acceptance-criteria.mjs';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { mergeableStateOptions } from './detect-conflicts.mjs';
import { ciFixRequestMarker, conflictFixRequestMarker, FIX_MARKER, fixRequestMarker, maxFixRounds, requestFix } from './request-fix.mjs';

// マージできるかどうかを、待たずに取得する
Object.assign(mergeableStateOptions, { attempts: 2, intervalMs: 0 });

const config = fixtureConfig();
const HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const OLD_SHA = '0123456789abcdef0123456789abcdef01234567';
const PR_NUMBER = 100;
const DEVELOP_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

const GROUP_SHA = '1111111111111111111111111111111111111111';

/**
 * PR の CI の実行を作る。
 *
 * @param {{ id: number, attempt: number, conclusion: string, headSha?: string, headBranch?: string }} fields
 */
function prRun({ id, attempt, conclusion, headSha = HEAD_SHA, headBranch = 'coding-agent/claude/issue-2-1' }) {
  return {
    id,
    run_attempt: attempt,
    event: 'pull_request',
    head_branch: headBranch,
    head_sha: headSha,
    conclusion,
    html_url: `https://github.com/kyro-studios/sandbox/actions/runs/${id}`,
  };
}

/**
 * Merge Queue の CI の実行を作る。
 *
 * @param {{ id: number, conclusion: string, branch?: string }} fields
 */
function groupRun({ id, conclusion, branch = `gh-readonly-queue/develop/pr-${PR_NUMBER}-${DEVELOP_SHA}` }) {
  return {
    id,
    run_attempt: 1,
    event: 'merge_group',
    head_branch: branch,
    head_sha: GROUP_SHA,
    conclusion,
    html_url: `https://github.com/kyro-studios/sandbox/actions/runs/${id}`,
  };
}

/**
 * PR を、既定ブランチとコンフリクトしている状態にする。
 *
 * @param {ReturnType<typeof createFakeGitHub>} fake
 */
function makeConflicting(fake) {
  fake.branches.develop = DEVELOP_SHA;
  const pull = fake.pulls.get(PR_NUMBER);
  assert.ok(pull?.detail);
  Object.assign(pull.detail, { mergeable: false, mergeable_state: 'dirty' });
}

/**
 * 機能の親 Issue と、仕様書の段階の Issue と、それを Close する Claude の PR を用意する。
 *
 * @param {object} [options]
 * @param {string} [options.author] PR の作成者
 * @param {{ state: string, commit_id: string }[]} [options.reviews] レビュー担当のレビュー (古いものから)
 * @param {string} [options.stage] PR が Close する段階の Issue の段階
 */
function setup({ author = 'claude-app[bot]', reviews = [{ state: 'CHANGES_REQUESTED', commit_id: HEAD_SHA }], stage = 'specification' } = {}) {
  const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions: { alice: 'write' } });
  const feature = fake.addIssue({
    title: 'ログイン機能',
    body: '### 機能名\n\nuser-login\n\n### 概要\n\nログインする',
    labels: ['feature'],
    user: 'alice',
  });
  const specification = fake.addIssue({ title: '仕様書: ログイン機能', labels: [`stage:${stage}`], parent: feature.number });
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

  it('既定ブランチとコンフリクトしていれば、取り込むコミットを指定して解消を依頼する', async () => {
    const { fake } = setup({ reviews: [{ state: 'APPROVED', commit_id: HEAD_SHA }] });
    makeConflicting(fake);

    const { result } = await run(fake);

    const request = result.requests?.[0];
    assert.deepEqual(request?.materials.conflict, { baseSha: DEVELOP_SHA });
    assert.equal(request?.materials.review, null);
    assert.ok(fake.comments[0].body.includes('既定ブランチとのコンフリクト'));
    assert.ok(fake.comments[0].body.includes(conflictFixRequestMarker(DEVELOP_SHA)));

    // 同じコミットとのコンフリクトは二重に依頼しない
    assert.deepEqual((await run(fake)).result, {});
  });

  it('差し戻しとコンフリクトが両方あれば、1 回の修正でまとめて依頼する', async () => {
    const { fake } = setup();
    makeConflicting(fake);

    const request = (await run(fake)).result.requests?.[0];

    assert.equal(request?.materials.review?.id, 1);
    assert.deepEqual(request?.materials.conflict, { baseSha: DEVELOP_SHA });
    assert.ok(fake.comments[0].body.includes(fixRequestMarker(1)));
    assert.ok(fake.comments[0].body.includes(conflictFixRequestMarker(DEVELOP_SHA)));
  });

  it('差し戻しもコンフリクトも無ければ、修正を依頼しない', async () => {
    const { fake } = setup({ reviews: [{ state: 'APPROVED', commit_id: HEAD_SHA }] });
    const pull = fake.pulls.get(PR_NUMBER);
    assert.ok(pull?.detail);
    Object.assign(pull.detail, { mergeable: true, mergeable_state: 'clean' });

    assert.deepEqual((await run(fake)).result, {});
  });

  it('今の head の PR の CI が再実行しても失敗していれば、既定ブランチを取り込むよう指定して修正を依頼する', async () => {
    const { fake } = setup({ reviews: [], stage: 'project' });
    fake.branches.develop = DEVELOP_SHA;
    fake.workflowRuns.push(prRun({ id: 501, attempt: 2, conclusion: 'failure' }));

    const { result } = await run(fake);

    const request = result.requests?.[0];
    assert.deepEqual(request?.materials.ciFailure, {
      event: 'pull_request',
      runId: 501,
      runAttempt: 2,
      runUrl: 'https://github.com/kyro-studios/sandbox/actions/runs/501',
      baseSha: DEVELOP_SHA,
    });
    assert.equal(request?.materials.review, null);
    assert.equal(request?.materials.conflict, null);
    assert.ok(fake.comments[0].body.includes('理由: CI の失敗'));
    assert.ok(fake.comments[0].body.includes(ciFixRequestMarker(501, 2)));

    // 同じ実行の失敗は二重に依頼しない
    assert.deepEqual((await run(fake)).result, {});
  });

  it('PR の CI の失敗は、自動の再実行の前 (1 回目の実行) と、古い head や別のブランチの実行では修正しない', async () => {
    const { fake } = setup({ reviews: [], stage: 'project' });
    fake.branches.develop = DEVELOP_SHA;
    fake.workflowRuns.push(prRun({ id: 501, attempt: 1, conclusion: 'failure' }));
    fake.workflowRuns.push(prRun({ id: 400, attempt: 2, conclusion: 'failure', headSha: OLD_SHA }));
    assert.deepEqual((await run(fake)).result, {});

    // 最新の実行が通っていれば、前の実行の失敗は見ない
    fake.workflowRuns.length = 0;
    fake.workflowRuns.push(prRun({ id: 501, attempt: 2, conclusion: 'failure' }), prRun({ id: 502, attempt: 1, conclusion: 'success' }));
    assert.deepEqual((await run(fake)).result, {});

    fake.workflowRuns.length = 0;
    fake.workflowRuns.push(prRun({ id: 503, attempt: 2, conclusion: 'failure', headBranch: 'other' }));
    assert.deepEqual((await run(fake)).result, {});
  });

  it('今の head が Approve の後に Merge Queue の CI の失敗で外されていれば、修正を依頼する', async () => {
    const { fake } = setup({ reviews: [{ state: 'APPROVED', commit_id: HEAD_SHA }], stage: 'project' });
    fake.branches.develop = DEVELOP_SHA;
    fake.mergeQueues.set(PR_NUMBER, {
      queued: false,
      events: [
        { type: 'added', createdAt: '2026-10-01T01:00:00Z' },
        { type: 'removed', createdAt: '2026-10-01T01:05:00Z', beforeCommit: GROUP_SHA },
      ],
    });
    fake.workflowRuns.push(groupRun({ id: 601, conclusion: 'failure' }));

    const { result } = await run(fake);

    assert.deepEqual(result.requests?.[0].materials.ciFailure, {
      event: 'merge_group',
      runId: 601,
      runAttempt: 1,
      runUrl: 'https://github.com/kyro-studios/sandbox/actions/runs/601',
      baseSha: DEVELOP_SHA,
    });
    assert.ok(fake.comments[0].body.includes('理由: Merge Queue の CI の失敗'));
    assert.ok(fake.comments[0].body.includes(ciFixRequestMarker(601, 1)));
  });

  it('Merge Queue の CI の失敗とみなすのは、外されたことの beforeCommit の実行が失敗し、今もキューに無いときだけ', async () => {
    /**
     * @param {object} options
     * @param {boolean} [options.queued]
     * @param {string} [options.removedAt]
     * @param {string} [options.conclusion]
     * @param {string} [options.branch]
     * @param {string} [options.approvedSha]
     */
    const attempt = async ({ queued = false, removedAt = '2026-10-01T01:05:00Z', conclusion = 'failure', branch, approvedSha = HEAD_SHA }) => {
      const { fake } = setup({ reviews: [{ state: 'APPROVED', commit_id: approvedSha }], stage: 'project' });
      fake.branches.develop = DEVELOP_SHA;
      fake.mergeQueues.set(PR_NUMBER, {
        queued,
        events: [
          { type: 'added', createdAt: '2026-10-01T01:00:00Z' },
          { type: 'removed', createdAt: removedAt, beforeCommit: GROUP_SHA },
        ],
      });
      fake.workflowRuns.push(groupRun({ id: 601, conclusion, branch }));
      return (await run(fake)).result;
    };

    assert.equal((await attempt({})).requests?.length, 1);
    // 外された後に、またキューに入っている
    assert.deepEqual(await attempt({ queued: true }), {});
    // コンフリクトや人の操作で外された (Merge Queue の CI は通っている)
    assert.deepEqual(await attempt({ conclusion: 'success' }), {});
    // 外されたのが、今の head の Approve より前
    assert.deepEqual(await attempt({ removedAt: '2026-09-30T00:00:00Z' }), {});
    // 今の head が Approve されていない (外された後に新しいコミットが push された)
    assert.deepEqual(await attempt({ approvedSha: OLD_SHA }), {});
    // 実行のブランチ名が、別の PR のもの
    assert.deepEqual(await attempt({ branch: `gh-readonly-queue/develop/pr-999-${DEVELOP_SHA}` }), {});
  });

  it('文書の段階の PR では、CI が失敗しても修正を依頼しない (原因が PR の外にあるため)', async () => {
    const { fake } = setup({ reviews: [] });
    fake.branches.develop = DEVELOP_SHA;
    fake.workflowRuns.push(prRun({ id: 501, attempt: 2, conclusion: 'failure' }));
    assert.deepEqual((await run(fake)).result, {});
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

describe('requestFix (実装タスクの受け入れ基準)', () => {
  /**
   * PR が Close する Issue を、受け入れ基準を割り当てた実装タスクに置き換える。
   *
   * @param {string} body 実装タスクの Issue の本文
   * @param {string | undefined} criteria 受け入れ基準のファイル (省略すると、ファイルが無い機能)
   */
  function setupTask(body, criteria) {
    const { fake, feature } = setup();
    const planning = fake.addIssue({ title: '実装計画', labels: ['stage:planning'], parent: feature.number });
    const task = fake.addIssue({ title: 'API を作る', body, labels: ['stage:implementation', 'agent:claude'], parent: planning.number });
    const pull = fake.pulls.get(PR_NUMBER);
    assert.ok(pull?.detail);
    pull.closing = [task.number];
    pull.detail.body = 'Closes #' + task.number;
    if (criteria !== undefined) {
      fake.files.set('docs/features/1-user-login/acceptance-criteria.json', criteria);
    }
    return { fake, task };
  }

  const file = formatCriteriaFile({
    feature: 1,
    next_number: 3,
    criteria: ['AC1-1', 'AC1-2'].map((id) => ({ id, kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' })),
  });

  it('割り当ての印から読んだ識別子を、修正の依頼の資料に含める', async () => {
    const { fake } = setupTask('本文\n\n' + assignmentMarker(['AC1-2']), file);
    const { result } = await run(fake);
    assert.deepEqual(result.requests?.[0].materials.acceptanceCriteria, ['AC1-2']);
  });

  it('受け入れ基準のファイルが無い機能では、null にする', async () => {
    const { fake } = setupTask('本文', undefined);
    const { result } = await run(fake);
    assert.equal(result.requests?.[0].materials.acceptanceCriteria, null);
  });

  it('割り当ての印が壊れていれば、修正を依頼せずに PR で知らせる', async () => {
    const { fake } = setupTask('印の無い本文', file);
    const { result } = await run(fake);
    assert.deepEqual(result, {});
    const comment = fake.comments.at(-1);
    assert.equal(comment?.issue_number, PR_NUMBER);
    assert.match(comment?.body ?? '', /修正を依頼できませんでした。#\d+ の本文に、受け入れ基準の割り当ての印がありません/);
  });
});
