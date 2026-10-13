/**
 * Issue の権限、Sub Issue、Blocked by、ラベルを扱う GitHub API の呼び出し。
 */

import { agentLabel } from './config.mjs';

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

/**
 * 依存先の Issue (Sub Issue と Blocked by の Issue)
 * @typedef {object} DependencyIssue
 * @property {number} number
 * @property {'OPEN' | 'CLOSED'} state
 * @property {{ nodes: { number: number, state: 'OPEN' | 'CLOSED' | 'MERGED' }[] }} closedByPullRequestsReferences 依存先を Close する (した) PR
 */

/**
 * @typedef {object} DependencyConnection
 * @property {number} totalCount
 * @property {DependencyIssue[]} nodes
 */

const DEPENDENCY_QUERY = `
  fragment Dependency on Issue {
    number
    state
    closedByPullRequestsReferences(first: 50, includeClosedPrs: true) {
      nodes { number state }
    }
  }

  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        subIssues(first: 100) { totalCount nodes { ...Dependency } }
        blockedBy(first: 100) { totalCount nodes { ...Dependency } }
      }
    }
  }
`;

/**
 * Issue の依存先 (Sub Issue と Blocked by の Issue) のうち、解決していないものを、理由とあわせて返す。
 * 依存先が Close されていて、紐づく PR に Open のまま残っているものが無ければ、解決したとみなす
 * (マージされずに Close された PR は、破棄されたものとして扱う)。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber
 * @returns {Promise<string[]>} 解決していない理由の一覧 (空なら、すべて解決している)
 */
export async function findUnresolvedDependencies(github, repository, issueNumber) {
  /** @type {{ repository: { issue: { subIssues: DependencyConnection, blockedBy: DependencyConnection } | null } }} */
  const result = await github.graphql(DEPENDENCY_QUERY, { ...repository, number: issueNumber, headers: GRAPHQL_HEADERS });
  const issue = result.repository.issue;
  if (issue === null) {
    return [`#${issueNumber} が見つかりません`];
  }
  return [...unresolvedIn('Sub Issue', issue.subIssues), ...unresolvedIn('Blocked by の Issue', issue.blockedBy)];
}

/**
 * @param {string} kind ログに表示する依存先の種類
 * @param {DependencyConnection} dependencies
 * @returns {string[]}
 */
function unresolvedIn(kind, dependencies) {
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
 * Close された Issue を待っていた Issue (親 Issue と、Blocking していた Issue) の番号を返す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber Close された Issue
 * @returns {Promise<number[]>}
 */
export async function findWaitingIssueNumbers(github, repository, issueNumber) {
  /** @type {{ repository: { issue: { parent: { number: number } | null, blocking: { nodes: { number: number }[] } } | null } }} */
  const result = await github.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          parent { number }
          blocking(first: 100) { nodes { number } }
        }
      }
    }`,
    { ...repository, number: issueNumber, headers: GRAPHQL_HEADERS },
  );
  const issue = result.repository.issue;
  if (issue === null) {
    return [];
  }
  return [...new Set([...(issue.parent === null ? [] : [issue.parent.number]), ...issue.blocking.nodes.map((node) => node.number)])];
}

/**
 * Issue の深さ (親の無い Issue を 1 とする) を返す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} issueNumber
 * @returns {Promise<number>}
 */
export async function measureIssueDepth(github, repository, issueNumber) {
  let depth = 1;
  for (let current = await getParentNumber(github, repository, issueNumber); current !== undefined; ) {
    depth++;
    current = await getParentNumber(github, repository, current);
  }
  return depth;
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

/** 担当のエージェントを表すラベルの色 */
const AGENT_LABEL_COLOR = '5319e7';

/**
 * ラベルが無ければ作る。存在しないラベルを Issue に付けたときの振る舞いは、公式のドキュメントで
 * 確かめられないため、付ける前に作っておく。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {{ name: string, color: string, description: string }} label
 */
export async function ensureLabel(github, repository, label) {
  try {
    await github.rest.issues.getLabel({ ...repository, name: label.name });
    return;
  } catch (error) {
    if (/** @type {{ status?: number }} */ (error).status !== 404) {
      throw error;
    }
  }
  try {
    await github.rest.issues.createLabel({ ...repository, ...label, description: label.description.slice(0, 100) });
  } catch (error) {
    // ほかの実行が同時に作った場合は、作成済み (422) になる
    if (/** @type {{ status?: number }} */ (error).status !== 422) {
      throw error;
    }
  }
}

/**
 * 担当のエージェントを表すラベル (agent:<識別子>) が無ければ作る。エージェントを登録したときに、
 * セットアップをやり直さずに済むようにするため。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {readonly import('./config.mjs').RegisteredAgent[]} agents
 */
export async function ensureAgentLabels(github, repository, agents) {
  const unique = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agent of unique.values()) {
    await ensureLabel(github, repository, { name: agentLabel(agent.id), color: AGENT_LABEL_COLOR, description: `担当のエージェント: ${agent.name}` });
  }
}
