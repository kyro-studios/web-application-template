import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { detectCiFailure } from './detect-ci-failure.mjs';

const config = fixtureConfig();
const HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const GROUP_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BRANCH = 'coding-agent/claude/issue-2-1';

/**
 * @param {Record<string, any>} [run] workflow_run の内容 (既定の内容を上書きする)
 */
function runContext(run = {}) {
  return {
    eventName: 'workflow_run',
    payload: {
      action: 'completed',
      workflow_run: {
        id: 501,
        name: 'Test',
        event: 'pull_request',
        conclusion: 'failure',
        run_attempt: 1,
        head_branch: BRANCH,
        head_sha: HEAD_SHA,
        head_repository: { full_name: 'kyro-studios/sandbox' },
        html_url: 'https://github.com/kyro-studios/sandbox/actions/runs/501',
        ...run,
      },
      repository: { full_name: 'kyro-studios/sandbox', default_branch: 'develop' },
    },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
}

/**
 * @param {object} [fields]
 * @param {string} [fields.author]
 * @param {string} [fields.sha]
 * @param {boolean} [fields.draft]
 */
function pullDetail({ author = 'claude-app[bot]', sha = HEAD_SHA, draft = false } = {}) {
  return {
    detail: {
      state: 'open',
      draft,
      user: { login: author },
      head: { sha, ref: BRANCH, repo: { full_name: 'kyro-studios/sandbox' } },
      base: { ref: 'develop', repo: { full_name: 'kyro-studios/sandbox' } },
    },
  };
}

/**
 * @param {ReturnType<typeof createFakeGitHub>} fake
 * @param {ReturnType<typeof runContext>} context
 */
async function run(fake, context) {
  // @ts-expect-error テストに必要な部分だけを渡す
  return detectCiFailure.run({ github: fake.github, context, core: createFakeCore(), config });
}

describe('detectCiFailure.matches', () => {
  /** @param {ReturnType<typeof runContext>} context */
  // @ts-expect-error テストに必要な部分だけを渡す
  const matches = (context) => detectCiFailure.matches({ context, config });

  it('失敗した Test のうち、同じリポジトリの PR と Merge Queue のものだけを処理する', async () => {
    assert.equal(await matches(runContext()), true);
    assert.equal(await matches(runContext({ event: 'merge_group' })), true);
    assert.equal(await matches(runContext({ conclusion: 'success' })), false);
    assert.equal(await matches(runContext({ conclusion: 'cancelled' })), false);
    assert.equal(await matches(runContext({ name: 'Validate Conventional Commits' })), false);
    assert.equal(await matches(runContext({ event: 'push' })), false);
    assert.equal(await matches(runContext({ head_repository: { full_name: 'someone/fork' } })), false);
  });
});

describe('detectCiFailure.run', () => {
  it('PR の CI の 1 回目の失敗では、失敗したジョブを再実行する', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.addPull(100, pullDetail());
    assert.deepEqual(await run(fake, runContext()), { rerun: [501] });
  });

  it('PR の CI が再実行しても失敗したら、PR の振り分けをやり直す', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.addPull(100, pullDetail());
    assert.deepEqual(await run(fake, runContext({ run_attempt: 2 })), { redispatch: [100] });
  });

  it('CI の後に新しいコミットが push された PR や、人が作った PR、Draft の PR は扱わない', async () => {
    const pushed = createFakeGitHub({ actor: config.agents.coordinator.bot });
    pushed.addPull(100, pullDetail({ sha: BASE_SHA }));
    assert.deepEqual(await run(pushed, runContext()), {});

    const human = createFakeGitHub({ actor: config.agents.coordinator.bot });
    human.addPull(100, pullDetail({ author: 'alice' }));
    assert.deepEqual(await run(human, runContext()), {});

    const draft = createFakeGitHub({ actor: config.agents.coordinator.bot });
    draft.addPull(100, pullDetail({ draft: true }));
    assert.deepEqual(await run(draft, runContext()), {});
  });

  it('Merge Queue の CI の失敗では、再実行せずに、ブランチ名から読んだ PR の振り分けをやり直す', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.addPull(100, pullDetail());
    const context = runContext({ event: 'merge_group', head_branch: `gh-readonly-queue/develop/pr-100-${BASE_SHA}`, head_sha: GROUP_SHA });
    assert.deepEqual(await run(fake, context), { redispatch: [100] });
  });

  it('Merge Queue の CI のブランチ名から PR を読めなければ、何もしない', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.addPull(100, pullDetail());
    assert.deepEqual(await run(fake, runContext({ event: 'merge_group', head_branch: 'gh-readonly-queue/develop/unexpected', head_sha: GROUP_SHA })), {});
  });
});
