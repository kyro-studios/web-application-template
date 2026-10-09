/**
 * Coding Agent を起動すべき Issue を特定し、起動条件を満たしているか判定する。
 *
 * 起動条件:
 * - Issue が Open で、対象エージェントのアカウントが Assignee に含まれている
 * - すべての Sub Issue が Close されている (state_reason は問わない)
 * - Sub Issue に紐づく PR のうち、Open のまま残っているものが無い
 *   (マージ済みの PR は解決済み、マージされずに Close された PR は破棄されたものとして扱う)
 * - Sub Issue を持たない Issue は、Assign された時点で条件を満たす
 *
 * 環境変数:
 * - AGENT_NAME: ログ出力用のエージェント名
 * - AGENT_ASSIGNEE: エージェントに対応する GitHub のログイン名
 * - ISSUE_NUMBER: workflow_dispatch で指定された Issue 番号
 */

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/**
 * @typedef {object} Repository
 * @property {string} owner リポジトリの所有者
 * @property {string} repo リポジトリ名
 */

/**
 * @typedef {'OPEN' | 'CLOSED'} IssueState
 * @typedef {'COMPLETED' | 'NOT_PLANNED' | 'DUPLICATE' | 'REOPENED'} IssueStateReason
 * @typedef {'OPEN' | 'CLOSED' | 'MERGED'} PullRequestState
 */

/**
 * Sub Issue を Close する (した) PR
 * @typedef {object} LinkedPullRequest
 * @property {number} number PR 番号
 * @property {string} url PR の URL
 * @property {PullRequestState} state PR の状態
 */

/**
 * @typedef {object} SubIssue
 * @property {number} number Issue 番号
 * @property {string} title タイトル
 * @property {string} url Issue の URL
 * @property {IssueState} state Issue の状態
 * @property {IssueStateReason | null} stateReason Close された理由 (Open なら null)
 * @property {{ nodes: LinkedPullRequest[] }} closedByPullRequestsReferences 紐づく PR
 */

/**
 * 起動対象の候補となる Issue
 * @typedef {object} TargetIssue
 * @property {number} number Issue 番号
 * @property {string} title タイトル
 * @property {string} body 本文
 * @property {string} url Issue の URL
 * @property {IssueState} state Issue の状態
 * @property {{ nodes: { login: string }[] }} assignees Assignee の一覧
 * @property {{ totalCount: number, nodes: SubIssue[] }} subIssues Sub Issue の一覧
 */

/**
 * PARENT_QUERY の応答
 * @typedef {object} ParentQueryResult
 * @property {{ issue: { parent: { number: number } | null } | null }} repository
 */

/**
 * ISSUE_QUERY の応答
 * @typedef {object} IssueQueryResult
 * @property {{ issue: TargetIssue | null }} repository
 */

/** @type {ReadonlySet<string>} */
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

const PARENT_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        parent { number }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number
        title
        body
        url
        state
        assignees(first: 50) { nodes { login } }
        subIssues(first: 100) {
          totalCount
          nodes {
            number
            title
            url
            state
            stateReason
            closedByPullRequestsReferences(first: 50, includeClosedPrs: true) {
              nodes { number url state }
            }
          }
        }
      }
    }
  }
`;

/** Sub Issue の API はプレビュー期間中にこのヘッダーを要求していたため、互換性のために付与する */
const GRAPHQL_HEADERS = { 'GraphQL-Features': 'sub_issues' };

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function resolveTarget({ github, context, core }) {
  core.setOutput('ready', 'false');

  const agentName = process.env.AGENT_NAME ?? 'Coding Agent';
  const assignee = (process.env.AGENT_ASSIGNEE ?? '').trim();
  if (assignee === '') {
    core.notice(`${agentName} に対応する Assignee がリポジトリ変数に設定されていないため、スキップします`);
    return;
  }

  const issueNumber = await findCandidateIssueNumber({ github, context, core, assignee });
  if (issueNumber === undefined) {
    return;
  }

  if (!(await actorCanWrite({ github, context, core }))) {
    return;
  }

  const issue = await fetchIssue(github, context.repo, issueNumber);
  if (issue === null) {
    core.setFailed(`Issue #${issueNumber} が見つかりません (PR の番号を指定していないか確認してください)`);
    return;
  }

  const blockers = findBlockers(issue, assignee);
  if (blockers.length > 0) {
    core.info(`Issue #${issue.number} はまだ起動条件を満たしていません:`);
    for (const blocker of blockers) {
      core.info(`- ${blocker}`);
    }
    return;
  }

  core.info(`Issue #${issue.number} は起動条件を満たしています`);
  core.setOutput('ready', 'true');
  core.setOutput('issue-number', String(issue.number));
  core.setOutput('issue-title', issue.title);
  core.setOutput('issue-url', issue.url);
  core.setOutput('task', buildTask(issue));
}

/**
 * イベントの種類に応じて、判定対象となる Issue の番号を返す。
 *
 * @param {Pick<AsyncFunctionArguments, 'github' | 'context' | 'core'> & { assignee: string }} args
 * @returns {Promise<number | undefined>} 判定対象の Issue 番号。判定対象が無い場合は undefined
 */
async function findCandidateIssueNumber({ github, context, core, assignee }) {
  if (context.eventName === 'workflow_dispatch') {
    const number = Number.parseInt(process.env.ISSUE_NUMBER ?? '', 10);
    if (!Number.isInteger(number) || number <= 0) {
      core.setFailed(`Issue 番号が不正です: ${process.env.ISSUE_NUMBER}`);
      return undefined;
    }
    return number;
  }

  if (context.eventName !== 'issues') {
    core.notice(`${context.eventName} イベントは対象外です`);
    return undefined;
  }

  const { action, issue } = context.payload;
  if (issue === undefined) {
    core.notice('イベントに Issue の情報が含まれていないため、スキップします');
    return undefined;
  }

  if (action === 'assigned') {
    const assigned = context.payload.assignee?.login ?? '';
    if (!sameLogin(assigned, assignee)) {
      core.info(`今回 Assign されたのは ${assigned} のため、スキップします`);
      return undefined;
    }
    return issue.number;
  }

  if (action === 'closed') {
    // Close された Issue 自身ではなく、その親 Issue が起動対象の候補になる
    /** @type {ParentQueryResult} */
    const result = await github.graphql(PARENT_QUERY, {
      ...context.repo,
      number: issue.number,
      headers: GRAPHQL_HEADERS,
    });
    const parent = result.repository.issue?.parent;
    if (!parent) {
      core.info(`Issue #${issue.number} には親 Issue が無いため、スキップします`);
      return undefined;
    }
    core.info(`Sub Issue #${issue.number} が Close されたため、親 Issue #${parent.number} を判定します`);
    return parent.number;
  }

  core.info(`issues.${action} イベントは対象外です`);
  return undefined;
}

/**
 * ワークフローを起動したユーザーがリポジトリへの書き込み権限を持つか確認する。
 * 書き込み権限の無いユーザーが Sub Issue を Close しただけでエージェントが動かないようにする。
 *
 * @param {Pick<AsyncFunctionArguments, 'github' | 'context' | 'core'>} args
 * @returns {Promise<boolean>} 書き込み権限を持つなら true
 */
async function actorCanWrite({ github, context, core }) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...context.repo,
      username: context.actor,
    });
    if (WRITE_PERMISSIONS.has(data.permission)) {
      return true;
    }
    core.notice(`${context.actor} には書き込み権限が無いため、スキップします (必要に応じて手動実行してください)`);
    return false;
  } catch (error) {
    core.notice(`${context.actor} の権限を確認できなかったため、スキップします: ${error}`);
    return false;
  }
}

/**
 * @param {AsyncFunctionArguments['github']} github
 * @param {Repository} repo
 * @param {number} number Issue 番号
 * @returns {Promise<TargetIssue | null>} Issue が存在しない場合は null
 */
async function fetchIssue(github, repo, number) {
  /** @type {IssueQueryResult} */
  const result = await github.graphql(ISSUE_QUERY, {
    ...repo,
    number,
    headers: GRAPHQL_HEADERS,
  });
  return result.repository.issue;
}

/**
 * 起動を妨げている理由の一覧を返す。空なら起動条件を満たしている。
 *
 * @param {TargetIssue} issue
 * @param {string} assignee エージェントに対応する GitHub のログイン名
 * @returns {string[]}
 */
function findBlockers(issue, assignee) {
  /** @type {string[]} */
  const blockers = [];

  if (issue.state !== 'OPEN') {
    blockers.push('Issue が Close されています');
  }

  if (!issue.assignees.nodes.some((node) => sameLogin(node.login, assignee))) {
    blockers.push(`${assignee} が Assignee に含まれていません`);
  }

  if (issue.subIssues.totalCount > issue.subIssues.nodes.length) {
    blockers.push(`Sub Issue が多すぎるため判定できません (${issue.subIssues.totalCount} 件)`);
  }

  for (const subIssue of issue.subIssues.nodes) {
    if (subIssue.state !== 'CLOSED') {
      blockers.push(`Sub Issue #${subIssue.number} が Open のままです`);
      continue;
    }
    for (const pullRequest of subIssue.closedByPullRequestsReferences.nodes) {
      if (pullRequest.state === 'OPEN') {
        blockers.push(`Sub Issue #${subIssue.number} に紐づく PR #${pullRequest.number} がマージされていません`);
      }
    }
  }

  return blockers;
}

/**
 * エージェントに渡すタスクの説明を Markdown で組み立てる。
 *
 * @param {TargetIssue} issue
 * @returns {string}
 */
function buildTask(issue) {
  const lines = [
    `# Issue #${issue.number}: ${issue.title}`,
    '',
    issue.url,
    '',
    '## 本文',
    '',
    issue.body.trim() || '(本文なし)',
  ];

  if (issue.subIssues.nodes.length > 0) {
    lines.push('', '## 解決済みの Sub Issue', '');
    for (const subIssue of issue.subIssues.nodes) {
      const merged = subIssue.closedByPullRequestsReferences.nodes
        .filter((pullRequest) => pullRequest.state === 'MERGED')
        .map((pullRequest) => `#${pullRequest.number}`);
      const suffix = merged.length > 0 ? ` (マージ済み PR: ${merged.join(', ')})` : '';
      lines.push(`- #${subIssue.number} ${subIssue.title}${suffix}`);
    }
  }

  return lines.join('\n');
}

/**
 * GitHub のログイン名は大文字と小文字を区別しないため、小文字にそろえて比較する。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameLogin(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
