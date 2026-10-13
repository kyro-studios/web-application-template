import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { HALTED_LABEL } from './halt.mjs';
import { createRouter, describeEvent, eventKey } from './route.mjs';
import { createFakeCore, createFakeGitHub } from './testing/fake-github.mjs';
import { createFixtureRoot } from './testing/fixture-config.mjs';

/** テスト用の設定ファイルを置いたディレクトリ (リポジトリの設定に左右されないようにする) */
let ROOT_DIR = '';

before(async () => {
  ROOT_DIR = await createFixtureRoot();
});

after(async () => {
  await rm(ROOT_DIR, { recursive: true, force: true });
});
const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * @param {string} eventName
 * @param {string} [action]
 */
function createContext(eventName, action) {
  return { eventName, payload: action === undefined ? {} : { action }, runId: 987 };
}

/**
 * @param {Partial<import('./agent-request.mjs').AgentRequest>} [overrides]
 * @returns {import('./agent-request.mjs').AgentRequest}
 */
function createRequest(overrides = {}) {
  return {
    id: 'issue-12',
    agent: 'claude',
    mode: 'create',
    stage: 'specification',
    issueNumber: 12,
    pullRequestNumber: null,
    targetSha: SHA,
    execution: { model: null, effort: null },
    materials: {},
    ...overrides,
  };
}

/**
 * @param {(args: any) => Promise<void>} step
 * @param {ReturnType<typeof createContext>} context
 * @param {ReturnType<typeof createFakeGitHub>} [fake]
 */
async function runStep(step, context, fake = createFakeGitHub({ actor: 'coordinator-app[bot]' })) {
  const core = createFakeCore();
  await step({ github: fake.github, context: { repo: { owner: 'kyro-studios', repo: 'sandbox' }, ...context }, core });
  return core;
}

describe('eventKey', () => {
  it('アクションがあればイベント名とつなげる', () => {
    assert.equal(eventKey(createContext('issues', 'opened')), 'issues.opened');
    assert.equal(eventKey(createContext('workflow_dispatch')), 'workflow_dispatch');
  });
});

describe('describeEvent', () => {
  it('イベントと、対象の Issue や PR の番号、または push のコミットを示す', () => {
    assert.equal(describeEvent({ eventName: 'issues', payload: { action: 'closed', issue: { number: 12 } } }), '`issues.closed` (#12)');
    assert.equal(describeEvent({ eventName: 'workflow_dispatch', payload: { inputs: { 'issue-number': '34' } } }), '`workflow_dispatch` (#34)');
    assert.equal(describeEvent({ eventName: 'push', payload: { after: 'abcdef0123' } }), '`push` (abcdef0)');
  });
});

describe('match', () => {
  /** @type {string | undefined} */
  let savedWorkspace;

  beforeEach(() => {
    savedWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = ROOT_DIR;
  });

  afterEach(() => {
    if (savedWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = savedWorkspace;
    }
  });

  it('処理するハンドラーがあれば、進行役の GitHub App の Client ID を出力する', async () => {
    const { match } = createRouter([
      { name: 'skip', events: ['issues.closed'], matches: async () => false, run: async () => ({}) },
      { name: 'handle', events: ['issues.closed'], run: async () => ({}) },
    ]);

    const core = await runStep(match, createContext('issues', 'closed'));

    assert.equal(core.outputs.handled, 'true');
    assert.equal(core.outputs['coordinator-client-id'], 'coordinator-client-id');
  });

  it('処理するハンドラーが無ければ、何も出力しない', async () => {
    const { match } = createRouter([
      { name: 'skip', events: ['issues.closed'], matches: async () => false, run: async () => ({}) },
    ]);

    assert.equal((await runStep(match, createContext('issues', 'closed'))).outputs.handled, 'false');
    assert.equal((await runStep(match, createContext('issues', 'opened'))).outputs.handled, 'false');
  });

  it('設定に問題があれば失敗する', async () => {
    process.env.GITHUB_WORKSPACE = tmpdir();
    const { match } = createRouter([{ name: 'handle', events: ['issues.closed'], run: async () => ({}) }]);

    const core = await runStep(match, createContext('issues', 'closed'));

    assert.equal(core.outputs.handled, 'false');
    assert.match(core.failures[0], /Coding Agent の設定に問題があります/);
  });
});

describe('route', () => {
  /** @type {string} */
  let requestDir;
  /** @type {Record<string, string | undefined>} */
  let savedEnv;

  beforeEach(async () => {
    requestDir = await mkdtemp(join(tmpdir(), 'coding-agent-route-'));
    savedEnv = { GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE, REQUEST_DIR: process.env.REQUEST_DIR };
    process.env.GITHUB_WORKSPACE = ROOT_DIR;
    process.env.REQUEST_DIR = requestDir;
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(requestDir, { recursive: true, force: true });
  });

  it('処理するハンドラーをすべて実行し、依頼を保存して、担当エージェントのワークフローの呼び出し方を出力する', async () => {
    /** @type {string[]} */
    const called = [];
    const { route } = createRouter([
      {
        name: 'first',
        events: ['issues.closed'],
        run: async ({ config }) => {
          called.push('first');
          assert.ok(config.agents.agents.claude);
          return { requests: [createRequest()] };
        },
      },
      { name: 'skip', events: ['issues.closed'], matches: async () => false, run: async () => ({ requests: [createRequest({ id: 'skip' })] }) },
      {
        name: 'second',
        events: ['issues.closed'],
        run: async () => {
          called.push('second');
          return { requests: [createRequest({ id: 'issue-13', issueNumber: 13 })], redispatch: [3, 3, 4] };
        },
      },
    ]);

    const core = await runStep(route, createContext('issues', 'closed'));

    assert.deepEqual(core.failures, []);
    assert.deepEqual(called, ['first', 'second']);
    const dispatches = JSON.parse(core.outputs.dispatches);
    assert.deepEqual(
      dispatches.map((/** @type {{ requestId: string, workflow: string }} */ dispatch) => [dispatch.requestId, dispatch.workflow]),
      [
        ['issue-12', 'coding-agent-claude.yml'],
        ['issue-13', 'coding-agent-claude.yml'],
      ],
    );
    assert.equal(dispatches[0].inputs['request-run-id'], '987');
    assert.deepEqual((await readdir(requestDir)).sort(), ['issue-12.json', 'issue-13.json']);
    // 振り分けをやり直す Issue は、重複を取り除いて出力する
    assert.deepEqual(JSON.parse(core.outputs['redispatch-issues']), [3, 4]);
  });

  it('停止中は、停止中も動かすハンドラーだけを実行し、処理しなかったことを停止中の Issue に残す', async () => {
    const fake = createFakeGitHub({ actor: 'coordinator-app[bot]' });
    const haltIssue = fake.addIssue({ title: '停止中', labels: [HALTED_LABEL] });
    /** @type {string[]} */
    const called = [];
    const { route } = createRouter([
      {
        name: '段階の起動',
        events: ['issues.closed'],
        run: async () => {
          called.push('launch');
          return { requests: [createRequest()] };
        },
      },
      {
        name: '検知',
        events: ['issues.closed'],
        runsWhileHalted: true,
        run: async () => {
          called.push('detect');
          return {};
        },
      },
    ]);

    const context = { ...createContext('issues', 'closed'), payload: { action: 'closed', issue: { number: 12 } } };
    const core = await runStep(route, context, fake);

    assert.deepEqual(called, ['detect']);
    assert.equal(core.outputs.dispatches, '[]');
    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].issue_number, haltIssue.number);
    assert.match(fake.comments[0].body, /停止中のため、`issues\.closed` \(#12\) の「段階の起動」を処理しませんでした/);

    // 停止中の Issue が Close されたら、再開する
    haltIssue.state = 'closed';
    await runStep(route, context, fake);
    assert.deepEqual(called, ['detect', 'launch', 'detect']);
  });

  it('依頼が無ければ、何も保存しない', async () => {
    const { route } = createRouter([{ name: 'handle', events: ['issues.closed'], run: async () => ({}) }]);

    const core = await runStep(route, createContext('issues', 'closed'));

    assert.equal(core.outputs.dispatches, '[]');
    assert.deepEqual(core.failures, []);
    assert.deepEqual(await readdir(requestDir), []);
  });

  it('依頼に 1 件でも問題があれば、どのエージェントも呼び出さない', async () => {
    const { route } = createRouter([
      {
        name: 'handle',
        events: ['issues.closed'],
        run: async () => ({
          requests: [
            createRequest(),
            createRequest({ id: 'issue-13', agent: 'jules' }),
            createRequest({ id: 'issue-12', issueNumber: 14 }),
          ],
        }),
      },
    ]);

    const core = await runStep(route, createContext('issues', 'closed'));

    assert.equal(core.outputs.dispatches, '[]');
    assert.equal(core.failures.length, 1);
    assert.match(core.failures[0], /issue-13: エージェント "jules" は登録されていません/);
    assert.match(core.failures[0], /issue-12: 依頼の識別子が重複しています/);
    assert.deepEqual(await readdir(requestDir), []);
  });
});
