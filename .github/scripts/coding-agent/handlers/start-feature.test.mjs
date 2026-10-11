import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEATURE_STAGES } from '../stages.mjs';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { startFeature } from './start-feature.mjs';

const config = fixtureConfig();

/**
 * @param {string} featureName
 */
function formBody(featureName) {
  return `### 機能名\n\n${featureName}\n\n### 概要\n\nログインできるようにする`;
}

/**
 * 機能の親 Issue と、それを作ったイベントを用意する。
 *
 * @param {object} [options]
 * @param {string} [options.featureName]
 * @param {Record<string, string>} [options.permissions]
 */
function setup({ featureName = 'user-login', permissions = { alice: 'write', 'claude-account': 'write' } } = {}) {
  const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions });
  const feature = fake.addIssue({ title: 'ログイン機能', body: formBody(featureName), labels: ['feature'], user: 'alice' });

  /**
   * @param {'opened' | 'edited'} action
   */
  const run = async (action) => {
    const core = createFakeCore();
    const context = {
      eventName: 'issues',
      payload: { action, issue: structuredClone(fake.issues.get(feature.number)) },
      repo: { owner: 'kyro-studios', repo: 'sandbox' },
    };
    // @ts-expect-error テストに必要な部分だけを渡す
    const result = await startFeature.run({ github: fake.github, context, core, config });
    return { core, requests: result.requests ?? [] };
  };

  return { fake, feature, run };
}

/**
 * @param {ReturnType<typeof createFakeGitHub>} fake
 * @param {number} parent
 */
function stageIssuesOf(fake, parent) {
  return [...fake.issues.values()].filter((issue) => issue.parent === parent);
}

describe('startFeature.matches', () => {
  it('feature ラベルの付いた Open の Issue だけを処理する', async () => {
    /**
     * @param {object} issue
     */
    const matches = (issue) =>
      // @ts-expect-error テストに必要な部分だけを渡す
      startFeature.matches({ context: { payload: { issue } }, config });

    assert.equal(await matches({ state: 'open', labels: [{ name: 'feature' }] }), true);
    assert.equal(await matches({ state: 'closed', labels: [{ name: 'feature' }] }), false);
    assert.equal(await matches({ state: 'open', labels: [{ name: 'stage:requirements' }] }), false);
  });
});

describe('startFeature.run', () => {
  it('段階の Issue を横並びの Sub Issue として作り、Blocked by でつないで担当を Assign する', async () => {
    const { fake, feature, run } = setup();

    const { requests, core } = await run('opened');

    assert.deepEqual(requests, []);
    assert.deepEqual(core.warnings, []);
    const stageIssues = stageIssuesOf(fake, feature.number);
    assert.deepEqual(
      stageIssues.map((issue) => issue.labels.map((label) => label.name)),
      FEATURE_STAGES.map((stage) => [`stage:${stage.id}`]),
    );
    assert.ok(stageIssues.every((issue) => issue.user.login === config.agents.coordinator.bot));
    assert.equal(stageIssues[0].title, '要件定義: ログイン機能');
    assert.match(stageIssues[1].body, /`docs\/features\/1-user-login\/specification\.md`/);
    assert.match(stageIssues[1].body, /要件定義: `docs\/features\/1-user-login\/requirements\.md`/);

    assert.deepEqual(
      stageIssues.map((issue) => issue.blockedBy),
      [[], ...stageIssues.slice(0, -1).map((issue) => [issue.number])],
    );
    assert.deepEqual(
      stageIssues.map((issue) => issue.assignees.map((user) => user.login)),
      [['alice'], ['claude-account'], ['claude-account'], ['claude-account'], ['claude-account']],
    );

    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].issue_number, feature.number);
    assert.match(fake.comments[0].body, /`docs\/features\/1-user-login\/`/);
  });

  it('途中まで作成済みなら、続きから作成する', async () => {
    const { fake, feature, run } = setup();
    await run('opened');
    const [, second, ...rest] = stageIssuesOf(fake, feature.number);
    // 2 つ目より後の段階の Issue の作成に失敗した状態にする
    for (const issue of rest) {
      fake.issues.delete(issue.number);
    }
    second.blockedBy = [];

    await run('opened');

    const stageIssues = stageIssuesOf(fake, feature.number);
    assert.equal(stageIssues.length, FEATURE_STAGES.length);
    assert.equal(stageIssues[1].number, second.number);
    assert.deepEqual(stageIssues[1].blockedBy, [stageIssues[0].number]);
  });

  it('段階の Issue を作り始めた後の編集では、何もしない', async () => {
    const { fake, feature, run } = setup();
    await run('opened');
    fake.issues.get(feature.number).body = formBody('another-name');

    await run('edited');

    assert.equal(stageIssuesOf(fake, feature.number).length, FEATURE_STAGES.length);
    assert.equal(fake.comments.length, 1);
  });

  it('機能名の形式が正しくなければ知らせ、本文が直されたら作成する', async () => {
    const { fake, feature, run } = setup({ featureName: 'User Login' });

    await run('opened');
    assert.equal(stageIssuesOf(fake, feature.number).length, 0);
    assert.equal(fake.comments.length, 1);
    assert.match(fake.comments[0].body, /機能名「User Login」の形式が正しくない/);

    fake.issues.get(feature.number).body = formBody('user-login');
    await run('edited');
    assert.equal(stageIssuesOf(fake, feature.number).length, FEATURE_STAGES.length);
  });

  it('書き込み権限の無いユーザーが作った Issue では、何もしない', async () => {
    const { fake, feature, run } = setup({ permissions: { alice: 'read' } });

    await run('opened');

    assert.equal(stageIssuesOf(fake, feature.number).length, 0);
    assert.equal(fake.comments.length, 0);
  });

  it('Assign できなかった担当を警告する', async () => {
    const { run } = setup({ permissions: { alice: 'write' } });

    const { core } = await run('opened');

    assert.equal(core.warnings.length, FEATURE_STAGES.length - 1);
    assert.match(core.warnings[0], /claude-account を Assign できませんでした/);
  });
});
