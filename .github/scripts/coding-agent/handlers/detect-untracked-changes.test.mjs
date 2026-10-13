import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { HALTED_LABEL } from '../halt.mjs';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { associationOptions, detectUntrackedChanges } from './detect-untracked-changes.mjs';

const config = fixtureConfig();
const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);
const MERGED = [{ number: 76, merged_at: '2026-10-12T00:00:00Z' }];

before(() => {
  associationOptions.intervalMs = 0;
});

/**
 * @param {ReturnType<typeof createFakeGitHub>} fake
 * @param {{ forced?: boolean, before?: string }} [payload]
 */
async function run(fake, payload = {}) {
  const core = createFakeCore();
  const context = {
    eventName: 'push',
    payload: { ref: 'refs/heads/develop', before: BEFORE, after: AFTER, forced: false, repository: { default_branch: 'develop' }, ...payload },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
  // @ts-expect-error テストに必要な部分だけを渡す
  const result = await detectUntrackedChanges.run({ github: fake.github, context, core, config });
  return { core, result };
}

/** @param {ReturnType<typeof createFakeGitHub>} fake */
function haltIssues(fake) {
  return [...fake.issues.values()].filter((issue) => issue.labels.some((label) => label.name === HALTED_LABEL));
}

describe('detectUntrackedChanges.matches', () => {
  it('既定ブランチへの push だけを処理する', async () => {
    /** @param {string} ref */
    const matches = (ref) =>
      // @ts-expect-error テストに必要な部分だけを渡す
      detectUntrackedChanges.matches({ context: { payload: { ref, repository: { default_branch: 'develop' } } }, config });

    assert.equal(await matches('refs/heads/develop'), true);
    assert.equal(await matches('refs/heads/coding-agent/claude/issue-12-1'), false);
  });

  it('停止中も実行する', () => {
    assert.equal(detectUntrackedChanges.runsWhileHalted, true);
  });
});

describe('detectUntrackedChanges.run', () => {
  it('PR を通ったコミットでは止めない', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.commits.push({ sha: AFTER, message: 'feat: 画面を作る (#76)', files: [{ filename: 'frontend/src/App.tsx', status: 'modified' }], pulls: MERGED });

    await run(fake);

    assert.deepEqual(haltIssues(fake), []);
  });

  it('仕組みのファイルだけを変える直接の push では止めない', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.commits.push({
      sha: AFTER,
      message: 'chore: sync with template',
      files: [
        { filename: '.github/scripts/coding-agent/route.mjs', status: 'modified' },
        { filename: '.github/coding-agent/agents.json', status: 'modified' },
        { filename: 'package.json', status: 'modified' },
      ],
      pulls: [],
    });

    await run(fake);

    assert.deepEqual(haltIssues(fake), []);
  });

  it('PR を通らずに仕組みのファイルの外を変えたら、停止中の Issue を作る', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    fake.commits.push(
      { sha: 'c'.repeat(40), message: 'feat: 画面を作る (#76)', files: [{ filename: 'frontend/src/App.tsx', status: 'added' }], pulls: MERGED },
      {
        sha: AFTER,
        message: 'chore: sync with template\n\n本文',
        files: [
          { filename: '.github/scripts/coding-agent/route.mjs', status: 'modified' },
          { filename: 'frontend/src/App.tsx', status: 'removed' },
          { filename: 'docs/features/1-login/spec.md', previous_filename: 'docs/features/1-login/specification.md', status: 'renamed' },
        ],
        // 閉じられただけの PR (マージされていない) は、ひも付いていないものとして扱う
        pulls: [{ number: 80, merged_at: null }],
      },
    );

    const { core } = await run(fake);

    const [issue] = haltIssues(fake);
    assert.ok(issue);
    assert.equal(issue.user.login, config.agents.coordinator.bot);
    assert.match(issue.title, /develop が PR を通さずに変更されました/);
    assert.match(issue.body, /- bbbbbbb chore: sync with template\n  - 削除: `frontend\/src\/App\.tsx`\n  - 名前の変更: `docs\/features\/1-login\/specification\.md` → `docs\/features\/1-login\/spec\.md`/);
    assert.doesNotMatch(issue.body, /route\.mjs|cccccc|本文/);
    assert.match(issue.body, /## 再開の手順/);
    assert.equal(fake.labels.get(HALTED_LABEL)?.name, HALTED_LABEL);
    assert.equal(core.warnings.length, 1);
  });

  it('マージの直後で PR のひも付きが反映されていなければ、取得し直す', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    const commit = { sha: AFTER, message: 'feat: 画面を作る (#76)', files: [{ filename: 'frontend/src/App.tsx', status: 'modified' }], pulls: /** @type {typeof MERGED} */ ([]) };
    fake.commits.push(commit);
    const list = fake.github.rest.repos.listPullRequestsAssociatedWithCommit;
    let calls = 0;
    fake.github.rest.repos.listPullRequestsAssociatedWithCommit = async (params) => {
      calls++;
      commit.pulls = calls >= 2 ? MERGED : [];
      return list(params);
    };

    await run(fake);

    assert.equal(calls, 2);
    assert.deepEqual(haltIssues(fake), []);
  });

  it('force push では、無条件に止める', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });

    await run(fake, { forced: true });

    assert.match(haltIssues(fake)[0]?.body ?? '', /force push で、`develop` の履歴が書き換えられました/);
  });

  it('既定ブランチの作成では止めない', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });

    await run(fake, { before: '0'.repeat(40) });

    assert.deepEqual(haltIssues(fake), []);
  });

  it('停止中の Issue が既にあれば、新しく作らずにコメントを足す', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    const existing = fake.addIssue({ title: '停止中', labels: [HALTED_LABEL] });
    // 進行役の App が作っていない Issue は、停止中の Issue として扱わない
    fake.addIssue({ title: '人が作った', labels: [HALTED_LABEL], user: 'alice' });

    await run(fake, { forced: true });

    assert.equal(haltIssues(fake).length, 2);
    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].issue_number, existing.number);
    assert.match(fake.comments[0].body, /force push/);
  });
});
