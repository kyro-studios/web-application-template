/**
 * アプリケーションの CI (coding-agent-test.yml) の実行と、Merge Queue のイベントを読む (仕様の 9.2)。
 *
 * - PR の CI: 今の head の SHA に対する pull_request の実行
 * - Merge Queue の CI: Merge Queue から外されたときの beforeCommit を head_sha とする merge_group の実行。
 *   beforeCommit が Merge Queue の CI の実行の head_sha と一致することは、確認用のリポジトリで確かめた
 */

/**
 * @typedef {import('./github-issues.mjs').GitHub} GitHub
 * @typedef {import('./github-issues.mjs').Repository} Repository
 */

/**
 * CI の実行
 * @typedef {object} CiRun
 * @property {number} id
 * @property {number} attempt 実行の回数 (run_attempt。再実行するたびに増える)
 * @property {string} event 元のイベント (pull_request か merge_group)
 * @property {string} headBranch
 * @property {string} headSha
 * @property {string | null} conclusion
 * @property {string} url
 */

/** CI のワークフローのファイル名 */
export const CI_WORKFLOW_FILE = 'coding-agent-test.yml';

/** CI のワークフローの名前 (振り分け用のワークフローの on.workflow_run.workflows に書いたもの) */
export const CI_WORKFLOW_NAME = 'Test';

/** CI の失敗とみなす conclusion */
export const FAILURE_CONCLUSION = 'failure';

/**
 * 修正の理由として表示する (修正の依頼のコメントと、修正の指示)、CI の失敗の種類を返す。
 *
 * @param {string} event 失敗した CI の元のイベント
 * @returns {string}
 */
export function ciFailureReason(event) {
  return event === 'merge_group' ? 'Merge Queue の CI の失敗' : 'CI の失敗';
}

/**
 * Merge Queue の CI の実行のブランチ名から、PR の番号を読む。形式に合わなければ undefined を返す。
 *
 * ブランチ名は gh-readonly-queue/<既定ブランチ>/pr-<番号>-<SHA> の形。接頭辞は公式のドキュメントにあり、
 * PR の番号を含むことは、ドキュメントの例と確認用のリポジトリで確かめた。
 *
 * @param {string | null | undefined} branch
 * @param {string} defaultBranch
 * @returns {number | undefined}
 */
export function parseMergeQueueBranch(branch, defaultBranch) {
  const prefix = `gh-readonly-queue/${defaultBranch}/`;
  if (typeof branch !== 'string' || !branch.startsWith(prefix)) {
    return undefined;
  }
  const match = /^pr-([1-9][0-9]*)-[0-9a-f]{40}$/.exec(branch.slice(prefix.length));
  if (match === null) {
    return undefined;
  }
  const number = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * REST の実行を CiRun の形にする。
 *
 * @param {any} run
 * @returns {CiRun}
 */
export function toCiRun(run) {
  return {
    id: run.id,
    attempt: run.run_attempt ?? 1,
    event: run.event,
    headBranch: run.head_branch ?? '',
    headSha: run.head_sha,
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? '',
  };
}

/**
 * CI の実行のうち、指定した head の SHA とイベントのものを、新しいものから順に返す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {{ headSha: string, event: 'pull_request' | 'merge_group' }} filter
 * @returns {Promise<CiRun[]>}
 */
export async function listCiRuns(github, repository, { headSha, event }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repository,
    workflow_id: CI_WORKFLOW_FILE,
    head_sha: headSha,
    event,
    per_page: 100,
  });
  return data.workflow_runs
    .filter((/** @type {any} */ run) => run.head_sha === headSha && run.event === event)
    .map(toCiRun)
    .sort((a, b) => b.id - a.id);
}

/**
 * PR の今の head に対する、PR の CI の最新の実行を返す。無ければ undefined を返す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {{ head: { sha: string, ref: string } }} pullRequest
 * @returns {Promise<CiRun | undefined>}
 */
export async function latestPullRequestRun(github, repository, pullRequest) {
  const runs = await listCiRuns(github, repository, { headSha: pullRequest.head.sha, event: 'pull_request' });
  return runs.find((run) => run.headBranch === pullRequest.head.ref);
}

/**
 * PR の Merge Queue の状態
 * @typedef {object} MergeQueueState
 * @property {boolean} queued Merge Queue に入っている
 * @property {{ type: 'added' | 'removed', createdAt: string, beforeCommit: string | null }[]} events Merge Queue のイベント (古いものから)
 */

/**
 * PR の Merge Queue の状態を取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} pullRequestNumber
 * @returns {Promise<MergeQueueState>}
 */
export async function getMergeQueueState(github, repository, pullRequestNumber) {
  /** @type {{ repository: { pullRequest: { mergeQueueEntry: { id: string } | null, timelineItems: { nodes: any[] } } | null } }} */
  const result = await github.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          mergeQueueEntry { id }
          timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT], last: 50) {
            nodes {
              __typename
              ... on AddedToMergeQueueEvent { createdAt }
              ... on RemovedFromMergeQueueEvent { createdAt beforeCommit { oid } }
            }
          }
        }
      }
    }`,
    { ...repository, number: pullRequestNumber },
  );
  const pullRequest = result.repository.pullRequest;
  if (pullRequest === null) {
    return { queued: false, events: [] };
  }
  return {
    queued: pullRequest.mergeQueueEntry !== null,
    events: pullRequest.timelineItems.nodes
      .filter((node) => node.__typename === 'AddedToMergeQueueEvent' || node.__typename === 'RemovedFromMergeQueueEvent')
      .map((node) => ({
        type: node.__typename === 'AddedToMergeQueueEvent' ? /** @type {const} */ ('added') : /** @type {const} */ ('removed'),
        createdAt: node.createdAt,
        beforeCommit: node.beforeCommit?.oid ?? null,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/**
 * 今の head が Merge Queue の CI の失敗で外されていれば、その実行を返す (仕様の 9.2)。次のすべてを満たすときに返す。
 * - PR が Merge Queue に入っていない
 * - 今の head が Approve された後の Merge Queue のイベントで、最後のものが外されたこと
 * - 外されたことの beforeCommit を head_sha とする Merge Queue の CI の実行が、失敗している
 *   (コンフリクトや人の操作で外された場合は、失敗した実行が無い)。実行のブランチ名も、この PR のものか確かめる
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {object} target
 * @param {number} target.pullRequestNumber
 * @param {string} target.approvedAt 今の head に対する、レビュー担当の Approve の日時
 * @param {string} target.defaultBranch
 * @returns {Promise<CiRun | undefined>}
 */
export async function findMergeQueueFailure(github, repository, { pullRequestNumber, approvedAt, defaultBranch }) {
  const state = await getMergeQueueState(github, repository, pullRequestNumber);
  if (state.queued) {
    return undefined;
  }
  const last = state.events.filter((event) => event.createdAt >= approvedAt).at(-1);
  if (last === undefined || last.type !== 'removed' || last.beforeCommit === null) {
    return undefined;
  }
  const runs = await listCiRuns(github, repository, { headSha: last.beforeCommit, event: 'merge_group' });
  return runs.find((run) => run.conclusion === FAILURE_CONCLUSION && parseMergeQueueBranch(run.headBranch, defaultBranch) === pullRequestNumber);
}
