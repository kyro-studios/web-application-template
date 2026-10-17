import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { formatCriteriaFile } from './acceptance-criteria.mjs';
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
  return { key, title: `タスク ${key}`, body: `${key} の本文`, agent: 'claude', parent: null, blocked_by: [], acceptance_criteria: [], ...overrides };
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
   * @param {import('./acceptance-criteria.mjs').CriteriaFile | string} [criteria] 受け入れ基準のファイル (省略すると、ファイルが無い機能)
   */
  async function setup(plan, criteria) {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot, permissions: { alice: 'write', 'claude-account': 'write' } });
    const feature = fake.addIssue({ labels: ['feature'], user: 'alice', body: '### 機能名\n\nuser-login\n\n### 概要\n\nログインする' });
    if (criteria !== undefined) {
      fake.files.set(`docs/features/${feature.number}-user-login/acceptance-criteria.json`, typeof criteria === 'string' ? criteria : formatCriteriaFile(criteria));
    }
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
    return { fake, planning, feature };
  }

  /**
   * @param {ReturnType<typeof createFakeGitHub>} fake
   */
  async function run(fake) {
    const core = createFakeCore();
    const context = { repo: { owner: 'kyro-studios', repo: 'sandbox' }, payload: { repository: { default_branch: 'develop' } } };
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

  it('計画から実装タスクの Issue を作り、親子関係と Blocked by を設定して、担当のラベルを付ける', async () => {
    const { fake, planning } = await setup(plan);

    const core = await run(fake);

    assert.deepEqual(core.failures, []);
    const [setupTask, featureTask, api, ui] = ['setup', 'feature', 'api', 'ui'].map((key) => findTask(fake, key));
    for (const issue of [setupTask, featureTask, api, ui]) {
      assert.equal(issue.user.login, config.agents.coordinator.bot);
      assert.deepEqual(issue.assignees, []);
    }
    assert.equal(setupTask.title, 'タスク setup');
    assert.match(setupTask.body, /^setup の本文\n\n---\n🤖 #\d+ の実装計画から作成しました/);

    assert.equal(setupTask.parent, planning.number);
    assert.equal(featureTask.parent, planning.number);
    assert.equal(api.parent, featureTask.number);
    assert.equal(ui.parent, featureTask.number);

    assert.deepEqual(api.blockedBy, [setupTask.number]);
    assert.deepEqual(ui.blockedBy.sort(), [setupTask.number, api.number].sort());

    // 担当が null のタスクには、担当のラベルを付けない
    assert.deepEqual(featureTask.labels, [{ name: 'stage:implementation' }]);
    for (const issue of [setupTask, api, ui]) {
      assert.deepEqual(issue.labels, [{ name: 'stage:implementation' }, { name: 'agent:claude' }]);
    }
    // 担当のラベルは、Issue を作るときではなく、最後に付ける (付けたときに起動するため)
    assert.ok(fake.events.every((event) => event.event === 'labeled' && event.label?.name === 'agent:claude'));
    assert.equal(fake.labels.get('agent:claude')?.name, 'agent:claude');

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

  /**
   * @param {number} feature
   * @param {string[]} ids
   * @returns {import('./acceptance-criteria.mjs').CriteriaFile}
   */
  function criteriaFile(feature, ids) {
    return {
      feature,
      next_number: ids.length + 1,
      criteria: ids.map((id) => ({ id, kind: 'api', behavior: `${id} の振る舞い`, expected: `${id} の結果`, spec_reference: '2.1' })),
    };
  }

  it('受け入れ基準のファイルがある機能では、割り当てた基準の内容と割り当ての印を本文に書く', async () => {
    const { fake } = await setup({
      summary: '計画',
      tasks: [task('setup'), task('api', { blocked_by: ['setup'], acceptance_criteria: ['AC1-2', 'AC1-1'] })],
    });
    const feature = [...fake.issues.values()].find((issue) => issue.labels.some((label) => label.name === 'feature'));
    fake.files.set(`docs/features/${feature?.number}-user-login/acceptance-criteria.json`, formatCriteriaFile(criteriaFile(Number(feature?.number), ['AC1-1', 'AC1-2'])));

    const core = await run(fake);

    assert.deepEqual(core.failures, []);
    const api = findTask(fake, 'api');
    assert.match(
      api.body,
      /^api の本文\n\n## 受け入れ基準\n\n.+\n\n### AC1-2 \(API\)\n\n- 確かめる振る舞い: AC1-2 の振る舞い\n- 期待する結果: AC1-2 の結果\n- 仕様書の該当箇所: 2\.1\n\n### AC1-1 \(API\)/,
    );
    assert.match(api.body, /<!-- coding-agent-acceptance-criteria: AC1-2 AC1-1 -->\n\n---\n🤖/);
    // 割り当てが無いタスクにも、識別子の無い印を書く
    assert.match(findTask(fake, 'setup').body, /割り当てた受け入れ基準はありません。\n\n<!-- coding-agent-acceptance-criteria: -->/);
  });

  it('割り当てに問題があるか、受け入れ基準のファイルが形式を満たさなければ、Issue を作らずに知らせる', async () => {
    const assignmentPlan = { summary: '計画', tasks: [task('a', { acceptance_criteria: ['AC1-1', 'AC1-9'] }), task('b', { agent: null, acceptance_criteria: ['AC1-1'] })] };
    const first = await setup(assignmentPlan, criteriaFile(1, ['AC1-1', 'AC1-2']));
    const count = first.fake.issues.size;
    const core = await run(first.fake);
    assert.equal(first.fake.issues.size, count);
    assert.equal(core.failures.length, 1);
    const body = first.fake.comments.at(-1)?.body ?? '';
    assert.match(body, /タスク "b" は担当が人/);
    assert.match(body, /AC1-9 は、受け入れ基準にありません/);
    assert.match(body, /AC1-1 が、複数のタスク \(a、b\) に割り当てられています/);
    assert.match(body, /AC1-2 が、どのタスクにも割り当てられていません/);

    const broken = await setup({ summary: '計画', tasks: [task('a')] }, '{ "feature": 1 }');
    const brokenCore = await run(broken.fake);
    assert.equal(brokenCore.failures.length, 1);
    assert.match(broken.fake.comments.at(-1)?.body ?? '', /受け入れ基準のファイルが形式を満たしていません/);
  });

  it('受け入れ基準のファイルが無い機能では、割り当ても印も無いまま Issue を作る', async () => {
    const { fake } = await setup({ summary: '計画', tasks: [task('a', { acceptance_criteria: ['AC1-1'] })] });
    const core = await run(fake);
    assert.match(fake.comments.at(-1)?.body ?? '', /この機能には受け入れ基準のファイルがありません/);
    assert.equal(core.failures.length, 1);

    const { fake: plain } = await setup({ summary: '計画', tasks: [task('a')] });
    assert.deepEqual((await run(plain)).failures, []);
    assert.doesNotMatch(findTask(plain, 'a').body, /coding-agent-acceptance-criteria/);
  });

  it('実装計画の Issue でなければ、何もしない', async () => {
    const { fake } = await setup(plan);
    const other = fake.addIssue({ labels: ['stage:planning'], user: 'alice' });
    process.env.PLANNING_ISSUE_NUMBER = String(other.number);

    const core = await run(fake);

    assert.match(core.failures[0], /実装計画の Issue ではありません/);
  });
});
