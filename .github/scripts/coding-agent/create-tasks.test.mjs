import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import createTasks, { maxPlanTasks, parseTaskMarker, taskMarker } from './create-tasks.mjs';
import { createFakeCore, createFakeGitHub } from './testing/fake-github.mjs';
import { createFixtureRoot, fixtureConfig } from './testing/fixture-config.mjs';

const config = fixtureConfig();
const RUN_ID = '555';

/** @type {string} */
let rootDir;

before(async () => {
  rootDir = await createFixtureRoot();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/**
 * @param {string} key
 * @param {Partial<import('./plan-validation.mjs').PlanTask>} [overrides]
 * @returns {import('./plan-validation.mjs').PlanTask}
 */
function task(key, overrides = {}) {
  return { key, title: `タスク ${key}`, body: `${key} の本文`, agent: 'claude', parent: null, blocked_by: [], ...overrides };
}

describe('maxPlanTasks', () => {
  it('Variables の値を使い、正しくなければ既定の 30 件にする', () => {
    assert.equal(maxPlanTasks('10'), 10);
    assert.equal(maxPlanTasks(undefined), 30);
    assert.equal(maxPlanTasks('0'), 30);
    assert.equal(maxPlanTasks('ten'), 30);
  });
});

describe('taskMarker', () => {
  it('実行の ID が一致する印だけを読み取る', () => {
    const body = `本文\n\n${taskMarker(RUN_ID, 'setup')}\n`;
    assert.equal(parseTaskMarker(body, RUN_ID), 'setup');
    assert.equal(parseTaskMarker(body, '999'), undefined);
    assert.equal(parseTaskMarker(null, RUN_ID), undefined);
  });
});

describe('createTasks', () => {
  /** @type {string} */
  let workDir;
  /** @type {Record<string, string | undefined>} */
  let savedEnv;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'coding-agent-plan-'));
    savedEnv = Object.fromEntries(
      ['GITHUB_WORKSPACE', 'PLAN_PATH', 'PLANNING_ISSUE_NUMBER', 'PLAN_RUN_ID', 'MAX_TASKS', 'RUN_URL'].map((name) => [name, process.env[name]]),
    );
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(workDir, { recursive: true, force: true });
  });

  /**
   * 機能の親 Issue と実装計画の Issue を用意し、計画をファイルに保存する。
   *
   * @param {unknown} plan
   */
  async function setup(plan) {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions: { alice: 'write', 'claude-account': 'write' } });
    const feature = fake.addIssue({ labels: ['feature'], user: 'alice' });
    const planning = fake.addIssue({ labels: ['stage:planning'], parent: feature.number });
    const planPath = join(workDir, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan));
    Object.assign(process.env, {
      GITHUB_WORKSPACE: rootDir,
      PLAN_PATH: planPath,
      PLANNING_ISSUE_NUMBER: String(planning.number),
      PLAN_RUN_ID: RUN_ID,
      RUN_URL: 'https://example.com/run',
    });
    delete process.env.MAX_TASKS;
    return { fake, planning };
  }

  /**
   * @param {ReturnType<typeof createFakeGitHub>} fake
   */
  async function run(fake) {
    const core = createFakeCore();
    const context = { repo: { owner: 'kyro-studios', repo: 'sandbox' } };
    // @ts-expect-error テストに必要な部分だけを渡す
    await createTasks({ github: fake.github, context, core, writeIntervalMs: 0 });
    return core;
  }

  /**
   * @param {ReturnType<typeof createFakeGitHub>} fake
   * @param {string} key
   */
  function findTask(fake, key) {
    const issue = [...fake.issues.values()].find((candidate) => parseTaskMarker(candidate.body, RUN_ID) === key);
    assert.ok(issue, key);
    return issue;
  }

  const plan = {
    summary: '土台を作ってから、画面と API を作る',
    tasks: [
      task('setup'),
      task('feature', { agent: null }),
      task('api', { parent: 'feature', blocked_by: ['setup'] }),
      task('ui', { parent: 'feature', blocked_by: ['setup', 'api'] }),
    ],
  };

  it('計画から実装タスクの Issue を作り、親子関係と Blocked by を設定して、担当を Assign する', async () => {
    const { fake, planning } = await setup(plan);

    const core = await run(fake);

    assert.deepEqual(core.failures, []);
    const [setupTask, featureTask, api, ui] = ['setup', 'feature', 'api', 'ui'].map((key) => findTask(fake, key));
    for (const issue of [setupTask, featureTask, api, ui]) {
      assert.deepEqual(issue.labels, [{ name: 'stage:implementation' }]);
      assert.equal(issue.user.login, config.agents.coordinator.bot);
    }
    assert.equal(setupTask.title, 'タスク setup');
    assert.match(setupTask.body, /^setup の本文\n\n---\n🤖 #\d+ の実装計画から作成しました/);

    assert.equal(setupTask.parent, planning.number);
    assert.equal(featureTask.parent, planning.number);
    assert.equal(api.parent, featureTask.number);
    assert.equal(ui.parent, featureTask.number);

    assert.deepEqual(api.blockedBy, [setupTask.number]);
    assert.deepEqual(ui.blockedBy.sort(), [setupTask.number, api.number].sort());

    // 担当が null のタスクは Assign しない
    assert.deepEqual(featureTask.assignees, []);
    assert.deepEqual(api.assignees.map((user) => user.login), ['claude-account']);

    const summary = fake.comments.at(-1);
    assert.equal(summary?.issue_number, planning.number);
    assert.match(summary?.body ?? '', /土台を作ってから、画面と API を作る/);
    assert.match(summary?.body ?? '', /タスク feature \(担当: 人\)/);
  });

  it('同じ実行をやり直しても、作成済みの Issue や関係を重ねて作らない', async () => {
    const { fake } = await setup(plan);
    await run(fake);
    const count = fake.issues.size;

    const core = await run(fake);

    assert.deepEqual(core.failures, []);
    assert.equal(fake.issues.size, count);
    assert.deepEqual(findTask(fake, 'api').blockedBy.length, 1);
  });

  it('計画に問題があれば、Issue を 1 件も作らずに実装計画の Issue で知らせる', async () => {
    const { fake, planning } = await setup({
      summary: '問題のある計画',
      tasks: [task('a', { agent: 'codex' }), task('b', { body: '<!-- coding-agent-plan:555:a -->' })],
    });
    const count = fake.issues.size;

    const core = await run(fake);

    assert.equal(fake.issues.size, count);
    assert.equal(core.failures.length, 1);
    const comment = fake.comments.at(-1);
    assert.equal(comment?.issue_number, planning.number);
    assert.match(comment?.body ?? '', /tasks\[0\]\.agent は claude のいずれか/);
    assert.match(comment?.body ?? '', /tasks\[1\]\.body に、仕組みの印/);
  });

  it('実装計画の Issue でなければ、何もしない', async () => {
    const { fake } = await setup(plan);
    const other = fake.addIssue({ labels: ['stage:planning'], user: 'alice' });
    process.env.PLANNING_ISSUE_NUMBER = String(other.number);

    const core = await run(fake);

    assert.match(core.failures[0], /実装計画の Issue ではありません/);
  });
});
