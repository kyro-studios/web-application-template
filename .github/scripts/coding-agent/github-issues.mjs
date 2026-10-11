/**
 * Issue の権限、Sub Issue、Blocked by を扱う GitHub API の呼び出し。
 */

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/**
 * @typedef {AsyncFunctionArguments['github']} GitHub
 */

/**
 * @typedef {{ owner: string, repo: string }} Repository
 */

/**
 * REST API の Issue のうち、使う項目
 * @typedef {object} RestIssue
 * @property {number} id
 * @property {string} node_id
 * @property {number} number
 * @property {string} title
 * @property {'open' | 'closed'} state
 * @property {{ login: string } | null} user
 * @property {(string | { name?: string })[]} labels
 * @property {{ login: string }[] | null} [assignees]
 */

/** 書き込み権限とみなすリポジトリの権限 */
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

/** Sub Issue と Blocked by を扱う GraphQL に付けるヘッダー */
const GRAPHQL_HEADERS = { 'GraphQL-Features': 'sub_issues' };

/**
 * アカウントがリポジトリへの書き込み権限を持っているか判定する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {string} login
 * @returns {Promise<boolean>}
 */
export async function hasWritePermission(github, repository, login) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...repository, username: login });
    return WRITE_PERMISSIONS.has(data.permission);
  } catch (error) {
    // コラボレーターでないアカウントは 404 になる
    if (/** @type {{ status?: number }} */ (error).status === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Issue の Sub Issue をすべて取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber
 * @returns {Promise<RestIssue[]>}
 */
export async function listSubIssues(github, repository, issueNumber) {
  return github.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
    ...repository,
    issue_number: issueNumber,
    per_page: 100,
  });
}

/**
 * Issue に Sub Issue を追加する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} parentNumber 親 Issue の番号
 * @param {number} subIssueId Sub Issue にする Issue の ID (番号ではない)
 * @returns {Promise<void>}
 */
export async function addSubIssue(github, repository, parentNumber, subIssueId) {
  await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
    ...repository,
    issue_number: parentNumber,
    sub_issue_id: subIssueId,
  });
}

/**
 * Issue を Blocking している Issue の番号を取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber
 * @returns {Promise<number[]>}
 */
export async function getBlockedBy(github, repository, issueNumber) {
  /** @type {{ repository: { issue: { blockedBy: { nodes: { number: number }[] } } | null } }} */
  const result = await github.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          blockedBy(first: 100) { nodes { number } }
        }
      }
    }`,
    { ...repository, number: issueNumber, headers: GRAPHQL_HEADERS },
  );
  return result.repository.issue?.blockedBy.nodes.map((node) => node.number) ?? [];
}

/**
 * Issue に Blocked by の関係を追加する。
 *
 * @param {GitHub} github
 * @param {string} issueNodeId Blocking される Issue の Node ID
 * @param {string} blockingIssueNodeId Blocking する Issue の Node ID
 * @returns {Promise<void>}
 */
export async function addBlockedBy(github, issueNodeId, blockingIssueNodeId) {
  await github.graphql(
    `mutation ($issueId: ID!, $blockingIssueId: ID!) {
      addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
        issue { id }
      }
    }`,
    { issueId: issueNodeId, blockingIssueId: blockingIssueNodeId, headers: GRAPHQL_HEADERS },
  );
}

/**
 * Issue の親 Issue の番号を取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber
 * @returns {Promise<number | undefined>}
 */
export async function getParentNumber(github, repository, issueNumber) {
  /** @type {{ repository: { issue: { parent: { number: number } | null } | null } }} */
  const result = await github.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          parent { number }
        }
      }
    }`,
    { ...repository, number: issueNumber, headers: GRAPHQL_HEADERS },
  );
  return result.repository.issue?.parent?.number;
}

/** 親をたどる回数の上限 (Sub Issue の階層の上限は 8) */
const MAX_ANCESTORS = 8;

/**
 * Issue 自身か、その祖先から、指定したラベルの付いた最も近い Issue を探す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber
 * @param {string} label
 * @returns {Promise<(RestIssue & { body?: string | null }) | undefined>}
 */
export async function findLabeledAncestor(github, repository, issueNumber, label) {
  /** @type {number | undefined} */
  let current = issueNumber;
  for (let depth = 0; current !== undefined && depth <= MAX_ANCESTORS; depth++) {
    const { data } = await github.rest.issues.get({ ...repository, issue_number: current });
    if (hasLabel(/** @type {RestIssue} */ (data).labels, label)) {
      return /** @type {RestIssue & { body?: string | null }} */ (data);
    }
    current = await getParentNumber(github, repository, current);
  }
  return undefined;
}

/**
 * ラベルの一覧に、指定した名前のラベルが含まれているか判定する。
 *
 * @param {readonly (string | { name?: string })[]} labels
 * @param {string} name
 * @returns {boolean}
 */
export function hasLabel(labels, name) {
  return labels.some((label) => (typeof label === 'string' ? label : label.name) === name);
}
