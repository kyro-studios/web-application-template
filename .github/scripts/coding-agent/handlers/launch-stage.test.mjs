import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { LAUNCH_MARKER, launchStage, wakeWaitingStages } from './launch-stage.mjs';

const config = fixtureConfig();
const DEVELOP_SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * 機能の親 Issue (#1) と、段階の Issue (#2〜#6) を、機能の開始と同じ形で用意する。
 */
function setup() {
  const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions: { alice: 'write', mallory: 'read' } });
  fake.branches.develop = DEVELOP_SHA;
  const feature = fake.addIssue({
    title: 'ログイン機能',
    body: '### 機能名\n\nuser-login\n\n### 概要\n\nログインする',
    labels: ['feature'],
    user: 'alice',
  });
  const stages = ['requirements', 'specification', 'domain-model', 'architecture', 'planning'].map((stage) =>
    fake.addIssue({
      title: `${stage}: ログイン機能`,
      body: `${stage} の段階`,
      labels: [`stage:${stage}`],
      parent: feature.number,
      assignees: [stage === 'requirements' ? 'alice' : 'claude-account'],
    }),
  );
  for (let index = 1; index < stages.length; index++) {
    stages[index].blockedBy.push(stages[index - 1].number);
  }
  const [requirements, specification, domainModel, architecture, planning] = stages;
  return { fake, feature, requirements, specification, domainModel, architecture, planning };
}

/**
 * @param {ReturnType<typeof setup>['fake']} fake
 * @param {object} context
 * @param {import('../route.mjs').Handler} handler
 */
async function run(fake, context, handler) {
  const core = createFakeCore();
  // @ts-expect-error テストに必要な部分だけを渡す
  const result = await handler.run({ github: fake.github, context: { repo: { owner: 'kyro-studios', repo: 'sandbox' }, ...context }, core, config });
  return { result, core };
}

/**
 * @param {number} issueNumber
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @param {string} [options.actor]
 */
function dispatchContext(issueNumber, { force = false, actor = 'github-actions[bot]' } = {}) {
  return {
    eventName: 'workflow_dispatch',
    actor,
    payload: { inputs: { 'issue-number': String(issueNumber), force }, repository: { default_branch: 'develop' } },
  };
}

/**
 * @param {number} issueNumber
 * @param {string} actor
 */
function closedContext(issueNumber, actor) {
  return { eventName: 'issues', actor, payload: { action: 'closed', issue: { number: issueNumber } } };
}

/**
 * @param {ReturnType<typeof setup>['fake']} fake
 * @param {number} issueNumber
 */
function close(fake, issueNumber) {
  const issue = fake.issues.get(issueNumber);
  assert.ok(issue);
  issue.state = 'closed';
  issue.closingPulls = [{ number: 100, state: 'MERGED' }];
}

describe('wakeWaitingStages', () => {
  it('Close された Issue を待っていた段階のうち、起動できるものの振り分けをやり直す', async () => {
    const { fake, requirements, specification } = setup();
    close(fake, requirements.number);

    const { result } = await run(fake, closedContext(requirements.number, 'codex-app[bot]'), wakeWaitingStages);

    // 親の機能の Issue は段階の Issue ではないため、起動しない
    assert.deepEqual(result, { redispatch: [specification.number] });
  });

  it('依存先に紐づく PR がマージされていなければ、起動しない', async () => {
    const { fake, requirements } = setup();
    close(fake, requirements.number);
    const issue = fake.issues.get(requirements.number);
    assert.ok(issue);
    issue.closingPulls = [{ number: 101, state: 'OPEN' }];

    const { result } = await run(fake, closedContext(requirements.number, 'alice'), wakeWaitingStages);

    assert.deepEqual(result, { redispatch: [] });
  });

  it('書き込み権限の無いユーザーが Close しても、起動しない', async () => {
    const { fake, requirements } = setup();
    close(fake, requirements.number);

    const { result } = await run(fake, closedContext(requirements.number, 'mallory'), wakeWaitingStages);

    assert.deepEqual(result, {});
  });
});

describe('launchStage.matches', () => {
  it('作成担当のエージェントが Assign されたときと、手動実行のときに処理する', async () => {
    /** @param {object} context */
    // @ts-expect-error テストに必要な部分だけを渡す
    const matches = (context) => launchStage.matches({ context, config });

    assert.equal(await matches({ eventName: 'issues', payload: { action: 'assigned', assignee: { login: 'Claude-Account' } } }), true);
    assert.equal(await matches({ eventName: 'issues', payload: { action: 'assigned', assignee: { login: 'alice' } } }), false);
    assert.equal(await matches(dispatchContext(3)), true);
  });
});

describe('launchStage.run', () => {
  it('前の段階が完了した段階の作成を、作成担当に依頼し、起動済みの印を残す', async () => {
    const { fake, feature, requirements, specification } = setup();
    close(fake, requirements.number);

    const { result } = await run(fake, dispatchContext(specification.number), launchStage);

    assert.equal(result.requests?.length, 1);
    const request = result.requests[0];
    assert.equal(request.id, `create-issue-${specification.number}`);
    assert.equal(request.agent, 'claude');
    assert.equal(request.mode, 'create');
    assert.equal(request.stage, 'specification');
    assert.equal(request.issueNumber, specification.number);
    assert.equal(request.pullRequestNumber, null);
    assert.equal(request.targetSha, DEVELOP_SHA);
    assert.deepEqual(request.execution, { model: 'claude-model', effort: 'high' });
    assert.deepEqual(request.materials.feature, { number: feature.number, title: 'ログイン機能', body: feature.body });
    assert.equal(request.materials.artifact, 'docs/features/1-user-login/specification.md');
    assert.deepEqual(request.materials.documents, [{ name: '要件定義', path: 'docs/features/1-user-login/requirements.md' }]);
    assert.deepEqual(request.materials.allowedFiles, { allow: ['docs/features/1-user-login/specification.md'], deny: [] });

    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].issue_number, specification.number);
    assert.ok(fake.comments[0].body.includes(LAUNCH_MARKER));
  });

  it('起動済みなら起動せず、force を指定した手動実行では起動し直す', async () => {
    const { fake, requirements, specification } = setup();
    close(fake, requirements.number);
    await run(fake, dispatchContext(specification.number), launchStage);

    assert.deepEqual((await run(fake, dispatchContext(specification.number), launchStage)).result, {});
    assert.equal((await run(fake, dispatchContext(specification.number, { force: true }), launchStage)).result.requests?.length, 1);
  });

  it('依存先が解決していない段階は起動しない', async () => {
    const { fake, specification } = setup();
    assert.deepEqual((await run(fake, dispatchContext(specification.number), launchStage)).result, {});
    assert.equal(fake.comments.length, 0);
  });

  it('実装タスクの作成を、Assign されている実装担当に依頼する', async () => {
    const { fake, planning } = setup();
    const task = fake.addIssue({ title: 'バックエンドの土台を作る', body: 'Gradle で作る', labels: ['stage:implementation'], parent: planning.number, assignees: ['claude-account'] });

    const { result } = await run(fake, dispatchContext(task.number), launchStage);

    const request = result.requests?.[0];
    assert.equal(request?.id, `create-issue-${task.number}`);
    assert.equal(request?.agent, 'claude');
    assert.equal(request?.stage, 'implementation');
    assert.deepEqual(request?.materials.issue, { number: task.number, title: 'バックエンドの土台を作る', body: 'Gradle で作る' });
    assert.equal(request?.materials.artifact, null);
    assert.deepEqual(request?.materials.allowedFiles, { allow: ['**'], deny: ['.github/**', 'docs/features/**'] });
    assert.deepEqual(
      request?.materials.documents.map((/** @type {{ path: string }} */ document) => document.path),
      ['docs/features/1-user-login/specification.md', 'docs/features/1-user-login/domain-model.md', 'docs/features/1-user-login/architecture.md'],
    );
    assert.equal(request?.materials.implementers, undefined);
    assert.ok(fake.comments[0].body.includes('「実装タスク」'));
  });

  it('実装タスクは、依存先のタスクと子タスクがすべて完了するまで起動しない', async () => {
    const { fake, planning } = setup();
    const foundation = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, assignees: ['claude-account'] });
    const parentTask = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, assignees: ['claude-account'] });
    const child = fake.addIssue({ labels: ['stage:implementation'], parent: parentTask.number, assignees: ['claude-account'] });
    child.blockedBy.push(foundation.number);

    assert.deepEqual((await run(fake, dispatchContext(child.number), launchStage)).result, {});
    assert.deepEqual((await run(fake, dispatchContext(parentTask.number), launchStage)).result, {});

    // 依存先のタスクが完了すると子タスクが起動でき、子タスクが完了すると親タスクが起動できる
    close(fake, foundation.number);
    assert.deepEqual((await run(fake, closedContext(foundation.number, 'codex-app[bot]'), wakeWaitingStages)).result, { redispatch: [child.number] });
    close(fake, child.number);
    assert.deepEqual((await run(fake, closedContext(child.number, 'codex-app[bot]'), wakeWaitingStages)).result, { redispatch: [parentTask.number] });
  });

  it('実装担当のエージェントが Assign されていないか、複数 Assign されている実装タスクは起動しない', async () => {
    const { fake, planning } = setup();
    const humanTask = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, assignees: ['alice'] });
    assert.deepEqual((await run(fake, dispatchContext(humanTask.number), launchStage)).result, {});

    // レビュー担当 (codex) は実装担当ではないため、担当として数えない
    const reviewerTask = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, assignees: ['codex-account'] });
    assert.deepEqual((await run(fake, dispatchContext(reviewerTask.number), launchStage)).result, {});

    config.agents.agents.devin = { ...config.agents.agents.claude, name: 'devin', assignee: 'devin-account', bot: 'devin-app[bot]' };
    config.agents.roles.implementation.implementers.push({ agent: 'devin' });
    try {
      const sharedTask = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, assignees: ['claude-account', 'devin-account'] });
      assert.deepEqual((await run(fake, dispatchContext(sharedTask.number), launchStage)).result, {});
    } finally {
      delete config.agents.agents.devin;
      config.agents.roles.implementation.implementers.pop();
    }
    assert.equal(fake.comments.length, 0);
  });

  it('実装計画では、担当に選べるエージェントとタスクの上限を依頼に含め、変更してよいファイルは含めない', async () => {
    const { fake, architecture, planning } = setup();
    close(fake, architecture.number);

    const { result } = await run(fake, dispatchContext(planning.number), launchStage);

    const request = result.requests?.[0];
    assert.equal(request?.stage, 'planning');
    assert.equal(request?.materials.artifact, null);
    assert.equal(request?.materials.allowedFiles, null);
    assert.deepEqual(request?.materials.implementers, [{ id: 'claude', name: 'claude' }]);
    // 実装計画の Issue は 2 階層目なので、その下に 6 階層まで置ける
    assert.deepEqual(request?.materials.planLimits, { maxTasks: 30, maxDepth: 6 });
    assert.deepEqual(
      request?.materials.documents.map((/** @type {{ path: string }} */ document) => document.path),
      ['docs/features/1-user-login/specification.md', 'docs/features/1-user-login/domain-model.md', 'docs/features/1-user-login/architecture.md'],
    );
  });

  it('作成担当が Assign されていない Issue や、進行役の App が作っていない Issue は起動しない', async () => {
    const { fake, requirements, specification } = setup();
    close(fake, requirements.number);
    const issue = fake.issues.get(specification.number);
    assert.ok(issue);
    issue.assignees = [];
    assert.deepEqual((await run(fake, dispatchContext(specification.number), launchStage)).result, {});

    const humanIssue = fake.addIssue({ labels: ['stage:specification'], user: 'alice', assignees: ['claude-account'] });
    assert.deepEqual((await run(fake, dispatchContext(humanIssue.number), launchStage)).result, {});
  });

  it('書き込み権限の無いユーザーの手動実行では起動しない', async () => {
    const { fake, requirements, specification } = setup();
    close(fake, requirements.number);

    assert.deepEqual((await run(fake, dispatchContext(specification.number, { actor: 'mallory' }), launchStage)).result, {});
  });
});
