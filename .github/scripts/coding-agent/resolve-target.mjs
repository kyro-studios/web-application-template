/**
 * Coding Agent を起動すべき Issue を特定し、起動条件を満たしているか判定する。
 *
 * 起動条件:
 * - Issue が Open で、対象エージェントのアカウントが Assignee に含まれている
 * - すべての依存先 (Sub Issue と Blocked by の Issue) が Close されている (state_reason は問わない)
 * - 依存先に紐づく PR のうち、Open のまま残っているものが無い
 *   (マージ済みの PR は解決済み、マージされずに Close された PR は破棄されたものとして扱う)
 * - 依存先を持たない Issue は、Assign された時点で条件を満たす
 *
 * Issue が Close されたときは、その親 Issue と、その Issue が Blocking していた Issue が候補になる。
 * 候補が複数になりうるため、起動条件を満たした候補ごとにワークフローを手動実行 (workflow_dispatch) し直す。
 *
 * 環境変数:
 * - AGENT_NAME: ログ出力用のエージェント名
 * - AGENT_ASSIGNEE: エージェントに対応する GitHub のログイン名
 * - ISSUE_NUMBER: workflow_dispatch で指定された Issue 番号
 * - TRUSTED_ACTORS: 書き込み権限の確認を省略するアカウント (カンマ区切り)
 *
 * 出力:
 * - ready: この実行でエージェントを起動すべきなら 'true'
 * - issue-number / issue-title / issue-url / task: ready のときの対象 Issue の情報
 * - dispatch-issues: 起動し直す Issue 番号の JSON 配列
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
 * 依存先の Issue を Close する (した) PR
 * @typedef {object} LinkedPullRequest
 * @property {number} number PR 番号
 * @property {string} url PR の URL
 * @property {PullRequestState} state PR の状態
 */

/**
 * 依存先の Issue (Sub Issue または Blocked by の Issue)
 * @typedef {object} DependencyIssue
 * @property {number} number Issue 番号
 * @property {string} title タイトル
 * @property {string} url Issue の URL
 * @property {IssueState} state Issue の状態
 * @property {IssueStateReason | null} stateReason Close された理由 (Open なら null)
 * @property {{ nodes: LinkedPullRequest[] }} closedByPullRequestsReferences 紐づく PR
 */

/**
 * @typedef {object} DependencyConnection
 * @property {number} totalCount 依存先の総数
 * @property {DependencyIssue[]} nodes 取得できた依存先
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
 * @property {DependencyConnection} subIssues Sub Issue の一覧
 * @property {DependencyConnection} blockedBy この Issue を Blocking している Issue の一覧
 */

/**
 * CLOSED_ISSUE_QUERY の応答
 * @typedef {object} ClosedIssueQueryResult
 * @property {{ issue: { parent: { number: number } | null, blocking: { nodes: { number: number }[] } } | null }} repository
 */

/**
 * ISSUE_QUERY の応答
 * @typedef {object} IssueQueryResult
 * @property {{ issue: TargetIssue | null }} repository
 */

/** @type {ReadonlySet<string>} */
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

const CLOSED_ISSUE_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        parent { number }
        blocking(first: 100) { nodes { number } }
      }
    }
  }
`;

const ISSUE_QUERY = `
  fragment Dependency on Issue {
    number
    title
    url
    state
    stateReason
    closedByPullRequestsReferences(first: 50, includeClosedPrs: true) {
      nodes { number url state }
    }
  }

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
          nodes { ...Dependency }
        }
        blockedBy(first: 100) {
          totalCount
          nodes { ...Dependency }
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
  core.setOutput('dispatch-issues', '[]');

  const agentName = process.env.AGENT_NAME ?? 'Coding Agent';
  const assignee = (process.env.AGENT_ASSIGNEE ?? '').trim();
  if (assignee === '') {
    core.notice(`${agentName} に対応する Assignee がリポジトリ変数に設定されていないため、スキップします`);
    return;
  }

  const candidates = await findCandidateIssueNumbers({ github, context, core, assignee });
  if (candidates.length === 0) {
    return;
  }

  if (!(await actorCanWrite({ github, context, core }))) {
    return;
  }

  // Close をきっかけにした判定では、この実行では起動せず、条件を満たした候補ごとに起動し直す
  if (context.eventName === 'issues' && context.payload.action === 'closed') {
    /** @type {number[]} */
    const ready = [];
    for (const number of candidates) {
      const issue = await fetchIssue(github, context.repo, number);
      if (issue !== null && isReady(issue, assignee, core)) {
        ready.push(issue.number);
      }
    }
    if (ready.length > 0) {
      core.info(`起動条件を満たした Issue: ${ready.map((number) => `#${number}`).join(', ')}`);
    }
    core.setOutput('dispatch-issues', JSON.stringify(ready));
    return;
  }

  const issue = await fetchIssue(github, context.repo, candidates[0]);
  if (issue === null) {
    core.setFailed(`Issue #${candidates[0]} が見つかりません (PR の番号を指定していないか確認してください)`);
    return;
  }
  if (!isReady(issue, assignee, core)) {
    return;
  }

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
 * @returns {Promise<number[]>} 判定対象の Issue 番号。判定対象が無い場合は空配列
 */
async function findCandidateIssueNumbers({ github, context, core, assignee }) {
  if (context.eventName === 'workflow_dispatch') {
    const number = Number.parseInt(process.env.ISSUE_NUMBER ?? '', 10);
    if (!Number.isInteger(number) || number <= 0) {
      core.setFailed(`Issue 番号が不正です: ${process.env.ISSUE_NUMBER}`);
      return [];
    }
    return [number];
  }

  if (context.eventName !== 'issues') {
    core.notice(`${context.eventName} イベントは対象外です`);
    return [];
  }

  const { action, issue } = context.payload;
  if (issue === undefined) {
    core.notice('イベントに Issue の情報が含まれていないため、スキップします');
    return [];
  }

  if (action === 'assigned') {
    const assigned = context.payload.assignee?.login ?? '';
    if (!sameLogin(assigned, assignee)) {
      core.info(`今回 Assign されたのは ${assigned} のため、スキップします`);
      return [];
    }
    return [issue.number];
  }

  if (action === 'closed') {
    // Close された Issue 自身ではなく、その Issue を待っていた Issue が起動対象の候補になる
    /** @type {ClosedIssueQueryResult} */
    const result = await github.graphql(CLOSED_ISSUE_QUERY, {
      ...context.repo,
      number: issue.number,
      headers: GRAPHQL_HEADERS,
    });
    const closed = result.repository.issue;
    const candidates = new Set([
      ...(closed?.parent ? [closed.parent.number] : []),
      ...(closed?.blocking.nodes.map((node) => node.number) ?? []),
    ]);
    if (candidates.size === 0) {
      core.info(`Issue #${issue.number} を待っている Issue が無いため、スキップします`);
      return [];
    }
    core.info(`Issue #${issue.number} が Close されたため、${[...candidates].map((number) => `#${number}`).join(', ')} を判定します`);
    return [...candidates];
  }

  core.info(`issues.${action} イベントは対象外です`);
  return [];
}

/**
 * ワークフローを起動したユーザーがリポジトリへの書き込み権限を持つか確認する。
 * 書き込み権限の無いユーザーが Issue を Close しただけでエージェントが動かないようにする。
 * Issue を作成する GitHub App や、起動し直す GitHub Actions のアカウントは確認を省略する。
 *
 * @param {Pick<AsyncFunctionArguments, 'github' | 'context' | 'core'>} args
 * @returns {Promise<boolean>} 書き込み権限を持つなら true
 */
async function actorCanWrite({ github, context, core }) {
  const trustedActors = (process.env.TRUSTED_ACTORS ?? '')
    .split(',')
    .map((actor) => actor.trim())
    .filter((actor) => actor !== '' && actor !== '[bot]');
  if (trustedActors.some((actor) => sameLogin(actor, context.actor))) {
    return true;
  }

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
 * 起動条件を満たしているか判定し、満たしていない場合は理由をログに出す。
 *
 * @param {TargetIssue} issue
 * @param {string} assignee エージェントに対応する GitHub のログイン名
 * @param {AsyncFunctionArguments['core']} core
 * @returns {boolean}
 */
function isReady(issue, assignee, core) {
  const blockers = findBlockers(issue, assignee);
  if (blockers.length > 0) {
    core.info(`Issue #${issue.number} はまだ起動条件を満たしていません:`);
    for (const blocker of blockers) {
      core.info(`- ${blocker}`);
    }
    return false;
  }
  core.info(`Issue #${issue.number} は起動条件を満たしています`);
  return true;
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

  blockers.push(...findUnresolvedDependencies('Sub Issue', issue.subIssues));
  blockers.push(...findUnresolvedDependencies('Blocked by の Issue', issue.blockedBy));

  return blockers;
}

/**
 * 解決していない依存先の一覧を返す。
 *
 * @param {string} kind ログに表示する依存先の種類
 * @param {DependencyConnection} dependencies
 * @returns {string[]}
 */
function findUnresolvedDependencies(kind, dependencies) {
  /** @type {string[]} */
  const unresolved = [];

  if (dependencies.totalCount > dependencies.nodes.length) {
    unresolved.push(`${kind} が多すぎるため判定できません (${dependencies.totalCount} 件)`);
  }

  for (const dependency of dependencies.nodes) {
    if (dependency.state !== 'CLOSED') {
      unresolved.push(`${kind} #${dependency.number} が Open のままです`);
      continue;
    }
    for (const pullRequest of dependency.closedByPullRequestsReferences.nodes) {
      if (pullRequest.state === 'OPEN') {
        unresolved.push(`${kind} #${dependency.number} に紐づく PR #${pullRequest.number} がマージされていません`);
      }
    }
  }

  return unresolved;
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

  lines.push(...formatDependencies('解決済みの Sub Issue', issue.subIssues));
  lines.push(...formatDependencies('先に完了した Issue (Blocked by)', issue.blockedBy));

  return lines.join('\n');
}

/**
 * @param {string} heading 見出し
 * @param {DependencyConnection} dependencies
 * @returns {string[]} 依存先が無い場合は空配列
 */
function formatDependencies(heading, dependencies) {
  if (dependencies.nodes.length === 0) {
    return [];
  }

  const lines = ['', `## ${heading}`, ''];
  for (const dependency of dependencies.nodes) {
    const merged = dependency.closedByPullRequestsReferences.nodes
      .filter((pullRequest) => pullRequest.state === 'MERGED')
      .map((pullRequest) => `#${pullRequest.number}`);
    const suffix = merged.length > 0 ? ` (マージ済み PR: ${merged.join(', ')})` : '';
    lines.push(`- #${dependency.number} ${dependency.title}${suffix}`);
  }
  return lines;
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
