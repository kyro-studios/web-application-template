import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { detectConflicts, mergeableStateOptions } from './detect-conflicts.mjs';

// マージできるかどうかを、待たずに取得する
Object.assign(mergeableStateOptions, { attempts: 2, intervalMs: 0 });

const config = fixtureConfig();

/**
 * @param {string} ref
 */
function pushContext(ref) {
  return {
    eventName: 'push',
    payload: { ref, repository: { default_branch: 'develop' } },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
}

/**
 * @param {object} fields
 * @param {string} fields.author
 * @param {boolean | null} fields.mergeable
 * @param {string} [fields.mergeableState]
 * @param {boolean} [fields.draft]
 */
function pullDetail({ author, mergeable, mergeableState = 'clean', draft = false }) {
  return {
    detail: {
      state: 'open',
      draft,
      user: { login: author },
      mergeable,
      mergeable_state: mergeableState,
      head: { sha: 'abcdef0123456789abcdef0123456789abcdef01', repo: { full_name: 'kyro-studios/sandbox' } },
      base: { ref: 'develop', repo: { full_name: 'kyro-studios/sandbox' } },
    },
  };
}

describe('detectConflicts.matches', () => {
  it('既定ブランチへの push だけを処理する', async () => {
    // @ts-expect-error テストに必要な部分だけを渡す
    assert.equal(await detectConflicts.matches({ context: pushContext('refs/heads/develop'), config }), true);
    // @ts-expect-error テストに必要な部分だけを渡す
    assert.equal(await detectConflicts.matches({ context: pushContext('refs/heads/coding-agent/claude/issue-1-1'), config }), false);
  });
});

describe('detectConflicts.run', () => {
  it('エージェントが作った PR のうち、コンフリクトしているものの振り分けをやり直す', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.addPull(101, pullDetail({ author: 'claude-app[bot]', mergeable: false, mergeableState: 'dirty' }));
    fake.addPull(102, pullDetail({ author: 'codex-app[bot]', mergeable: true }));
    // 人が作った PR と Draft の PR は、コンフリクトしていても扱わない
    fake.addPull(103, pullDetail({ author: 'alice', mergeable: false, mergeableState: 'dirty' }));
    fake.addPull(104, pullDetail({ author: 'claude-app[bot]', mergeable: false, mergeableState: 'dirty', draft: true }));
    // マージできるかどうかの計算が終わらない PR は、警告だけを出す
    fake.addPull(105, pullDetail({ author: 'claude-app[bot]', mergeable: null }));

    const core = createFakeCore();
    // @ts-expect-error テストに必要な部分だけを渡す
    const result = await detectConflicts.run({ github: fake.github, context: pushContext('refs/heads/develop'), core, config });

    assert.deepEqual(result, { redispatch: [101] });
  });
});
