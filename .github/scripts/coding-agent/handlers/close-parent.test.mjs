import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCore, createFakeGitHub } from '../testing/fake-github.mjs';
import { fixtureConfig } from '../testing/fixture-config.mjs';
import { closeParent } from './close-parent.mjs';

const config = fixtureConfig();

/**
 * @param {ReturnType<typeof createFakeGitHub>} fake
 * @param {number} closedNumber
 */
async function run(fake, closedNumber) {
  const core = createFakeCore();
  const context = {
    eventName: 'issues',
    payload: { action: 'closed', issue: { number: closedNumber } },
    repo: { owner: 'kyro-studios', repo: 'sandbox' },
  };
  // @ts-expect-error テストに必要な部分だけを渡す
  return closeParent.run({ github: fake.github, context, core, config });
}

describe('closeParent', () => {
  it('実装タスクがすべて Close されたら、実装計画の Issue を Close する', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    const planning = fake.addIssue({ labels: ['stage:planning'] });
    fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, state: 'closed' });
    const last = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, state: 'closed' });

    assert.deepEqual(await run(fake, last.number), []);

    assert.equal(fake.issues.get(planning.number)?.state, 'closed');
    assert.equal(fake.issues.get(planning.number)?.state_reason, 'completed');
    assert.match(fake.comments[0].body, /すべての実装タスクが完了した/);
  });

  it('すべての段階が Close されたら、機能の親 Issue を Close する', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    const feature = fake.addIssue({ labels: ['feature'], user: 'alice' });
    fake.addIssue({ labels: ['stage:requirements'], parent: feature.number, state: 'closed' });
    const planning = fake.addIssue({ labels: ['stage:planning'], parent: feature.number, state: 'closed' });

    await run(fake, planning.number);

    assert.equal(fake.issues.get(feature.number)?.state, 'closed');
    assert.match(fake.comments[0].body, /すべての段階が完了した/);
  });

  it('Open の Sub Issue が残っていれば、何もしない', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    const feature = fake.addIssue({ labels: ['feature'], user: 'alice' });
    const requirements = fake.addIssue({ labels: ['stage:requirements'], parent: feature.number, state: 'closed' });
    fake.addIssue({ labels: ['stage:specification'], parent: feature.number });

    await run(fake, requirements.number);

    assert.equal(fake.issues.get(feature.number)?.state, 'open');
    assert.equal(fake.comments.length, 0);
  });

  it('機能の親 Issue と実装計画の Issue 以外は、Close しない', async () => {
    const fake = createFakeGitHub({ actor: config.agents.coordinator.bot });
    // 人が作った、実装計画のラベルの付いた Issue
    const planning = fake.addIssue({ labels: ['stage:planning'], user: 'alice' });
    const task = fake.addIssue({ labels: ['stage:implementation'], parent: planning.number, state: 'closed' });
    // 実装タスクを親に持つ子タスク
    const child = fake.addIssue({ labels: ['stage:implementation'], parent: task.number, state: 'closed' });
    const root = fake.addIssue({ state: 'closed' });

    await run(fake, task.number);
    await run(fake, child.number);
    await run(fake, root.number);

    assert.equal(fake.issues.get(planning.number)?.state, 'open');
    assert.equal(fake.comments.length, 0);
  });
});
