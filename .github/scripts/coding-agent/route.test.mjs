import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRouter, eventKey } from './route.mjs';
import { createFakeCore } from './testing/fake-github.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));
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
    materials: {},
    ...overrides,
  };
}

/**
 * @param {(args: any) => Promise<void>} step
 * @param {ReturnType<typeof createContext>} context
 */
async function runStep(step, context) {
  const core = createFakeCore();
  await step({ github: {}, context, core });
  return core;
}

describe('eventKey', () => {
  it('アクションがあればイベント名とつなげる', () => {
    assert.equal(eventKey(createContext('issues', 'opened')), 'issues.opened');
    assert.equal(eventKey(createContext('workflow_dispatch')), 'workflow_dispatch');
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
      { name: 'skip', events: ['issues.closed'], matches: async () => false, run: async () => [] },
      { name: 'handle', events: ['issues.closed'], run: async () => [] },
    ]);

    const core = await runStep(match, createContext('issues', 'closed'));

    assert.equal(core.outputs.handled, 'true');
    assert.equal(core.outputs['coordinator-client-id'], 'your-coordinator-app-client-id');
  });

  it('処理するハンドラーが無ければ、何も出力しない', async () => {
    const { match } = createRouter([
      { name: 'skip', events: ['issues.closed'], matches: async () => false, run: async () => [] },
    ]);

    assert.equal((await runStep(match, createContext('issues', 'closed'))).outputs.handled, 'false');
    assert.equal((await runStep(match, createContext('issues', 'opened'))).outputs.handled, 'false');
  });

  it('設定に問題があれば失敗する', async () => {
    process.env.GITHUB_WORKSPACE = tmpdir();
    const { match } = createRouter([{ name: 'handle', events: ['issues.closed'], run: async () => [] }]);

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
          return [createRequest()];
        },
      },
      { name: 'skip', events: ['issues.closed'], matches: async () => false, run: async () => [createRequest({ id: 'skip' })] },
      {
        name: 'second',
        events: ['issues.closed'],
        run: async () => {
          called.push('second');
          return [createRequest({ id: 'issue-13', issueNumber: 13 })];
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
  });

  it('依頼が無ければ、何も保存しない', async () => {
    const { route } = createRouter([{ name: 'handle', events: ['issues.closed'], run: async () => [] }]);

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
        run: async () => [
          createRequest(),
          createRequest({ id: 'issue-13', agent: 'jules' }),
          createRequest({ id: 'issue-12', issueNumber: 14 }),
        ],
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
