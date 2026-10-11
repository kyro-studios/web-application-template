/**
 * 親 Issue の Close: Sub Issue がすべて Close されたら、親 Issue を Close する。
 *
 * GitHub は、Sub Issue がすべて Close されても親 Issue を自動では Close しない。
 * 対象にするのは、実装計画の Issue (すべての実装タスクが完了) と、機能の親 Issue (すべての段階が完了) だけにする。
 * 実装計画の Issue を Close すると、そのイベントで機能の親 Issue が改めて判定される。
 */

import { isCoordinator } from '../config.mjs';
import { getParentNumber, hasLabel, listSubIssues } from '../github-issues.mjs';
import { FEATURE_LABEL, stageOf } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../github-issues.mjs').RestIssue} RestIssue
 */

/** @type {Handler} */
export const closeParent = {
  name: '親 Issue の Close',
  events: ['issues.closed'],
  run: async ({ github, context, core, config }) => {
    const repository = context.repo;
    const closedNumber = /** @type {number} */ (context.payload.issue.number);

    const parentNumber = await getParentNumber(github, repository, closedNumber);
    if (parentNumber === undefined) {
      return {};
    }
    const { data } = await github.rest.issues.get({ ...repository, issue_number: parentNumber });
    const parent = /** @type {RestIssue} */ (data);
    if (parent.state !== 'open') {
      return {};
    }

    const isFeature = hasLabel(parent.labels, FEATURE_LABEL);
    const isPlanning = stageOf(parent.labels) === 'planning' && isCoordinator(config.agents, parent.user?.login);
    if (!isFeature && !isPlanning) {
      return {};
    }

    const subIssues = await listSubIssues(github, repository, parentNumber);
    if (subIssues.length === 0 || subIssues.some((issue) => issue.state !== 'closed')) {
      return {};
    }

    await github.rest.issues.createComment({
      ...repository,
      issue_number: parentNumber,
      body: isFeature
        ? '🤖 すべての段階が完了したため、この機能の Issue を Close します。'
        : '🤖 すべての実装タスクが完了したため、実装計画の Issue を Close します。',
    });
    await github.rest.issues.update({ ...repository, issue_number: parentNumber, state: 'closed', state_reason: 'completed' });
    core.info(`#${parentNumber} の Sub Issue がすべて Close されたため、Close しました`);
    return {};
  },
};
