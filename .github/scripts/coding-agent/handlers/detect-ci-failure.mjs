/**
 * CI の失敗の検知: アプリケーションの CI (coding-agent-test.yml) が失敗したら、その PR を特定する (仕様の 9.2)。
 *
 * 振り分け用のワークフローを、CI の workflow_run の completed でも起動する。元のイベントごとに、次のように PR を特定する。
 * - pull_request: head_branch と head_sha が一致する、Open の PR (workflow_run の pull_requests は空のことがあるため使わない)
 * - merge_group: head_branch (gh-readonly-queue/<既定ブランチ>/pr-<番号>-<SHA>) から読んだ番号の PR
 *
 * PR の CI は、不安定なテストに備えて一度だけ再実行する (run_attempt が 1 のとき)。再実行は、Actions の書き込み権限を
 * 含む進行役の App のトークンが要るため、ここでは再実行する実行を返すだけにし、振り分け用のワークフローが行う。
 * 再実行しても失敗したとき (run_attempt が 2 以上) と、Merge Queue の CI が失敗したときは、PR の番号を指定して
 * 振り分けをやり直す。修正の依頼 (request-fix.mjs) が、PR ごとの concurrency の中で、修正の条件を確かめて依頼する。
 */

import { CI_WORKFLOW_NAME, FAILURE_CONCLUSION, parseMergeQueueBranch } from '../ci-runs.mjs';
import { findAgentByBot } from '../config.mjs';
import { unhandledReason } from '../stage-context.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 */

/** PR の CI を自動で再実行する回数 (この回数の実行までは、失敗したら再実行する) */
export const AUTO_RERUN_ATTEMPTS = 1;

/** @type {Handler} */
export const detectCiFailure = {
  name: 'CI の失敗の検知',
  events: ['workflow_run.completed'],
  // 失敗した CI のうち、同じリポジトリの PR と Merge Queue のものだけを処理する
  matches: async ({ context }) => {
    const run = context.payload.workflow_run;
    return (
      run?.name === CI_WORKFLOW_NAME &&
      run.conclusion === FAILURE_CONCLUSION &&
      (run.event === 'pull_request' || run.event === 'merge_group') &&
      run.head_repository?.full_name === context.payload.repository?.full_name
    );
  },
  run: async ({ github, context, core, config }) => {
    const repository = context.repo;
    const run = context.payload.workflow_run;
    const defaultBranch = /** @type {string} */ (context.payload.repository?.default_branch);

    /** @type {any} */
    let pullRequest;
    if (run.event === 'merge_group') {
      const number = parseMergeQueueBranch(run.head_branch, defaultBranch);
      if (number === undefined) {
        core.notice(`Merge Queue の CI のブランチ名 (${run.head_branch}) から PR を特定できませんでした`);
        return {};
      }
      ({ data: pullRequest } = await github.rest.pulls.get({ ...repository, pull_number: number }));
    } else {
      /** @type {any[]} */
      const candidates = await github.paginate(github.rest.pulls.list, {
        ...repository,
        state: 'open',
        head: `${repository.owner}:${run.head_branch}`,
        per_page: 100,
      });
      pullRequest = candidates.find((candidate) => candidate.head.ref === run.head_branch && candidate.head.sha === run.head_sha);
      if (pullRequest === undefined) {
        core.info(`CI の実行 (${run.head_branch} の ${String(run.head_sha).slice(0, 7)}) の PR は、Open でないか、新しいコミットが push されています`);
        return {};
      }
    }

    const number = pullRequest.number;
    // 人が作った PR は、作った人が直す (GitHub が CI の失敗を通知する)
    if (findAgentByBot(config.agents, pullRequest.user?.login) === undefined) {
      core.info(`#${number} は登録済みのエージェントが作った PR ではないため、扱いません`);
      return {};
    }
    const unhandled = unhandledReason(pullRequest, defaultBranch);
    if (unhandled !== undefined) {
      core.info(`#${number} は扱いません: ${unhandled}`);
      return {};
    }

    if (run.event === 'pull_request' && (run.run_attempt ?? 1) <= AUTO_RERUN_ATTEMPTS) {
      core.info(`#${number} の CI が失敗したため、失敗したジョブを一度だけ再実行します (${run.html_url})`);
      return { rerun: [run.id] };
    }
    core.info(`#${number} の${run.event === 'merge_group' ? ' Merge Queue の' : ''} CI が失敗したため、修正を依頼するか確かめます (${run.html_url})`);
    return { redispatch: [number] };
  },
};
