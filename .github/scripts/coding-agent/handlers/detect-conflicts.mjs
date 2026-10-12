/**
 * コンフリクトの検知: 既定ブランチが更新されたら、エージェントが作った Open の PR がコンフリクトしていないか調べる。
 *
 * Approve されて自動マージを待っている PR がコンフリクトしても、PR のイベントは起きない。Merge Queue に入る前なら
 * pull_request.dequeued も起きない。そのため、既定ブランチへの push をきっかけに調べる。Merge Queue でコンフリクトして
 * 外された PR も、先の PR が既定ブランチにマージされた時点の push で見つかる。
 *
 * コンフリクトしている PR ごとに、PR の番号を指定して振り分けをやり直す。修正の依頼 (request-fix.mjs) が、
 * PR ごとの concurrency の中で、修正の条件を確かめて依頼する。
 */

import { findAgentByBot } from '../config.mjs';
import { getMergeableState } from '../github-pulls.mjs';
import { unhandledReason } from '../stage-context.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 */

/** コンフリクトしていることを表す mergeable_state */
export const CONFLICTING_STATE = 'dirty';

/**
 * マージできるかどうかを取得し直す設定 (テストで間隔を短くするために変えられるようにする)
 * @type {{ attempts?: number, intervalMs?: number }}
 */
export const mergeableStateOptions = {};

/** @type {Handler} */
export const detectConflicts = {
  name: 'コンフリクトの検知',
  events: ['push'],
  // 既定ブランチへの push だけを処理する
  matches: async ({ context }) => {
    const defaultBranch = context.payload.repository?.default_branch;
    return defaultBranch !== undefined && context.payload.ref === `refs/heads/${defaultBranch}`;
  },
  run: async ({ github, context, core, config }) => {
    const repository = context.repo;
    const defaultBranch = context.payload.repository?.default_branch;

    /** @type {any[]} */
    const pullRequests = await github.paginate(github.rest.pulls.list, { ...repository, state: 'open', base: defaultBranch, per_page: 100 });
    /** @type {number[]} */
    const redispatch = [];
    for (const pullRequest of pullRequests) {
      // 人が作った PR (要件定義書など) は、作った人が GitHub の画面で解消する
      if (findAgentByBot(config.agents, pullRequest.user?.login) === undefined) {
        continue;
      }
      const unhandled = unhandledReason(pullRequest, defaultBranch);
      if (unhandled !== undefined) {
        core.info(`#${pullRequest.number} は調べません: ${unhandled}`);
        continue;
      }
      const state = await getMergeableState(github, repository, pullRequest.number, mergeableStateOptions);
      if (state === CONFLICTING_STATE) {
        core.info(`#${pullRequest.number} は ${defaultBranch} とコンフリクトしています`);
        redispatch.push(pullRequest.number);
      } else if (state === 'unknown') {
        core.warning(`#${pullRequest.number} がマージできるかどうか、GitHub の計算が終わりませんでした`);
      }
    }
    return { redispatch };
  },
};
