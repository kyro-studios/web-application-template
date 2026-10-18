import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { HAND_OVER_REASONS, handOver, isHandOverRequested } from './hand-over.mjs';
import { launchStage } from './launch-stage.mjs';
import { requestFix } from './request-fix.mjs';

const config = fixtureConfig();
const PR_NUMBER = 50;

/**
 * 機能の親 Issue と、実装タスクの Issue と、それを Close する Claude の PR を用意する。
 */
function setup() {
  const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions: { alice: 'write', mallory: 'read' } });
  const feature = fake.addIssue({
    title: 'ログイン機能',
    body: '### 機能名\n\nuser-login\n\n### 概要\n\nログインする',
    labels: ['feature'],
    user: 'alice',
  });
  const planning = fake.addIssue({ title: '実装計画: ログイン機能', labels: ['stage:planning'], parent: feature.number });
  const task = fake.addIssue({ title: 'ログインの API を作る', labels: ['stage:implementation', 'agent:claude'], parent: planning.number });
  fake.addPull(PR_NUMBER, {
    closing: [task.number],
    detail: {
      state: 'open',
      draft: false,
      title: 'feat: ログインの API を追加する',
      body: `Closes #${task.number}`,
      user: { login: 'claude-app[bot]' },
      head: { sha: 'a'.repeat(40), ref: 'coding-agent/claude/issue-3-1', repo: { full_name: 'kyro-studios/sandbox' } },
      base: { sha: 'b'.repeat(40), ref: 'develop', repo: { full_name: 'kyro-studios/sandbox' } },
    },
  });
  return { fake, feature, task };
}

/**
 * @param {Record<string, string | boolean>} inputs
 * @param {string} [actor]
 */
function dispatchContext(inputs, actor = 'github-actions[bot]') {
  return {
    eventName: 'workflow_dispatch',
    actor,
    serverUrl: 'https://github.com',
    payload: { inputs, repository: { default_branch: 'develop' } },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
}

/**
 * @param {ReturnType<typeof setup>['fake']} fake
 * @param {object} context
 */
async function run(fake, context) {
  const core = createFakeCore();
  // @ts-expect-error テストに必要な部分だけを渡す
  const result = await handOver.run({ github: fake.github, context, core, config });
  return { result, core };
}

describe('handOver.matches', () => {
  it('引き継ぐ理由を指定した手動実行だけを、人への引き継ぎで扱い、段階の起動と修正の依頼では扱わない', async () => {
    const handOverContext = dispatchContext({ 'issue-number': '3', 'hand-over': 'test-failure' });
    const normalContext = dispatchContext({ 'issue-number': '3', 'hand-over': '' });
    assert.equal(isHandOverRequested(/** @type {never} */ (handOverContext)), true);
    assert.equal(isHandOverRequested(/** @type {never} */ (normalContext)), false);

    for (const [handler, expected] of /** @type {const} */ ([
      [handOver, [true, false]],
      [launchStage, [false, true]],
      [requestFix, [false, true]],
    ])) {
      // @ts-expect-error テストに必要な部分だけを渡す
      assert.equal(await handler.matches({ context: handOverContext, config }), expected[0], handler.name);
      // @ts-expect-error テストに必要な部分だけを渡す
      assert.equal(await handler.matches({ context: normalContext, config }), expected[1], handler.name);
    }
  });
});

describe('handOver.run', () => {
  it('作成のときは、段階の Issue に needs-human を付け、機能の作成者を Assign して、失敗したログへのリンクをコメントする', async () => {
    const { fake, task } = setup();

    await run(fake, dispatchContext({ 'issue-number': String(task.number), 'hand-over': 'test-failure', 'source-run-id': '123' }));

    const issue = fake.issues.get(task.number);
    assert.ok(issue?.labels.some((label) => label.name === 'needs-human'));
    assert.deepEqual(issue?.assignees.map((user) => user.login), ['alice']);
    const comment = fake.comments.find((candidate) => candidate.issue_number === task.number);
    assert.match(comment?.body ?? '', /テストが通りませんでした/);
    assert.match(comment?.body ?? '', /\(https:\/\/github\.com\/kyro-studios\/sandbox\/actions\/runs\/123\)/);
    assert.match(comment?.body ?? '', /@alice .*`force` を指定して手動実行/);
  });

  it('受け入れ基準を作れなかったときも、同じように引き継ぎ、理由をコメントする', async () => {
    const { fake, task } = setup();

    await run(fake, dispatchContext({ 'issue-number': String(task.number), 'hand-over': 'acceptance-criteria', 'source-run-id': '123' }));

    assert.ok(fake.issues.get(task.number)?.labels.some((label) => label.name === 'needs-human'));
    const comment = fake.comments.find((candidate) => candidate.issue_number === task.number);
    assert.match(comment?.body ?? '', /受け入れ基準のファイルを作れませんでした/);
  });

  it('修正のときは、PR に needs-human を付けて引き継ぐ', async () => {
    const { fake } = setup();

    await run(fake, dispatchContext({ 'issue-number': String(PR_NUMBER), 'hand-over': 'test-failure', 'source-run-id': '' }));

    const pull = fake.issues.get(PR_NUMBER);
    assert.ok(pull?.labels.some((label) => label.name === 'needs-human'));
    assert.deepEqual(pull?.assignees.map((user) => user.login), ['alice']);
    const comment = fake.comments.find((candidate) => candidate.issue_number === PR_NUMBER);
    assert.match(comment?.body ?? '', /@alice .*ラベルを外してください。外すと、改めてレビューします/);
    assert.doesNotMatch(comment?.body ?? '', /ワークフロー\]/);
  });

  it('CI の失敗の修正で変更が無かったときも、PR に needs-human を付けて引き継ぐ', async () => {
    const { fake } = setup();

    await run(fake, dispatchContext({ 'issue-number': String(PR_NUMBER), 'hand-over': 'ci-unresolved', 'source-run-id': '123' }));

    assert.ok(fake.issues.get(PR_NUMBER)?.labels.some((label) => label.name === 'needs-human'));
    const comment = fake.comments.find((candidate) => candidate.issue_number === PR_NUMBER);
    assert.match(comment?.body ?? '', /CI の失敗の修正を依頼しましたが、.*エージェントも変更を作りませんでした/);
  });

  it('エージェントのワークフローが指定する引き継ぐ理由は、すべて扱える', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile(new URL('../../../workflows/coding-agent-claude.yml', import.meta.url), 'utf8');
    const line = workflow.split('\n').find((candidate) => candidate.trim().startsWith('REASON:'));
    assert.ok(line);
    const reasons = [...line.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]).filter((reason) => reason !== 'true');
    assert.deepEqual(reasons.sort(), Object.keys(HAND_OVER_REASONS).sort());
  });

  it('段階の Issue でも、エージェントの PR でもなければ、引き継がない', async () => {
    const { fake, feature } = setup();

    await run(fake, dispatchContext({ 'issue-number': String(feature.number), 'hand-over': 'test-failure' }));

    assert.ok(!fake.issues.get(feature.number)?.labels.some((label) => label.name === 'needs-human'));
    assert.equal(fake.comments.length, 0);
  });

  it('理由、番号、実行の ID が正しくないか、書き込み権限の無い人の手動実行なら、引き継がない', async () => {
    const { fake, task } = setup();

    const unknown = await run(fake, dispatchContext({ 'issue-number': String(task.number), 'hand-over': 'unknown' }));
    assert.equal(unknown.core.failures.length, 1);
    const badNumber = await run(fake, dispatchContext({ 'issue-number': 'x', 'hand-over': 'test-failure' }));
    assert.equal(badNumber.core.failures.length, 1);
    const badRunId = await run(fake, dispatchContext({ 'issue-number': String(task.number), 'hand-over': 'test-failure', 'source-run-id': '1;rm' }));
    assert.equal(badRunId.core.failures.length, 1);
    await run(fake, dispatchContext({ 'issue-number': String(task.number), 'hand-over': 'test-failure' }, 'mallory'));

    assert.ok(!fake.issues.get(task.number)?.labels.some((label) => label.name === 'needs-human'));
    assert.equal(fake.comments.length, 0);
  });
});
