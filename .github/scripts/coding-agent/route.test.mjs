import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRouter, eventKey } from './route.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * actions/github-script の core のうち、振り分けで使うものを記録する。
 */
function createCore() {
  /** @type {Record<string, string>} */
  const outputs = {};
  /** @type {string[]} */
  const failures = [];
  return {
    outputs,
    failures,
    /** @param {string} name @param {string} value */
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    /** @param {string} message */
    setFailed: (message) => {
      failures.push(message);
    },
    info: () => {},
  };
}

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
 * @param {ReturnType<typeof createRouter>} route
 * @param {ReturnType<typeof createContext>} context
 */
async function runRoute(route, context) {
  const core = createCore();
  // @ts-expect-error テストに必要な部分だけを渡す
  await route({ github: {}, context, core });
  return core;
}

describe('eventKey', () => {
  it('アクションがあればイベント名とつなげる', () => {
    assert.equal(eventKey(createContext('issues', 'opened')), 'issues.opened');
    assert.equal(eventKey(createContext('workflow_dispatch')), 'workflow_dispatch');
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

  it('ハンドラーの無いイベントでは何もしない', async () => {
    const core = await runRoute(createRouter({}), createContext('issues', 'opened'));
    assert.equal(core.outputs.dispatches, '[]');
    assert.deepEqual(core.failures, []);
  });

  it('依頼を保存し、担当エージェントのワークフローの呼び出し方を出力する', async () => {
    const route = createRouter({
      'issues.closed': async ({ config }) => {
        assert.ok(config.agents.agents.claude);
        return [createRequest(), createRequest({ id: 'issue-13', issueNumber: 13 })];
      },
    });

    const core = await runRoute(route, createContext('issues', 'closed'));

    assert.deepEqual(core.failures, []);
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

  it('依頼に 1 件でも問題があれば、どのエージェントも呼び出さない', async () => {
    const route = createRouter({
      'issues.closed': async () => [
        createRequest(),
        createRequest({ id: 'issue-13', agent: 'jules' }),
        createRequest({ id: 'issue-12', issueNumber: 14 }),
      ],
    });

    const core = await runRoute(route, createContext('issues', 'closed'));

    assert.equal(core.outputs.dispatches, '[]');
    assert.equal(core.failures.length, 1);
    assert.match(core.failures[0], /issue-13: エージェント "jules" は登録されていません/);
    assert.match(core.failures[0], /issue-12: 依頼の識別子が重複しています/);
    assert.deepEqual(await readdir(requestDir), []);
  });

  it('設定に問題があれば失敗する', async () => {
    process.env.GITHUB_WORKSPACE = requestDir;
    const route = createRouter({ 'issues.closed': async () => [createRequest()] });

    const core = await runRoute(route, createContext('issues', 'closed'));

    assert.equal(core.outputs.dispatches, '[]');
    assert.match(core.failures[0], /Coding Agent の設定に問題があります/);
  });
});
