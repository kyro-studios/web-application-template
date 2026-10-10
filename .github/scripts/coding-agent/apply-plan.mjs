/**
 * 計画役のエージェントが出力した計画を検証し、GitHub App のトークンで Issue を作成する。
 *
 * エージェントの起動条件を満たす前に Assign しないよう、次の順番で処理する。
 * 1. すべての Issue を親タスクから順に作成し、Sub Issue として紐づける (Assignee なし)
 * 2. Blocked by の関係を設定する
 * 3. 最後に Assign する (ここでエージェントのワークフローが起動する)
 *
 * 本文に埋め込んだマーカーで作成済みの Issue を見分けるため、途中で失敗しても再実行すれば続きから処理する。
 *
 * 環境変数:
 * - PLAN_PATH: 計画 (JSON) のファイルパス
 * - DESIGN_ISSUE_NUMBER: 計画の元になった設計 Issue の番号
 * - MAX_TASKS: 1 回の計画で作成できるタスクの上限
 * - CLAUDE_CODE_ASSIGNEE / CODEX_ASSIGNEE / JULES_ASSIGNEE: 各エージェントに対応する GitHub のログイン名
 */

import { readFile } from 'node:fs/promises';
import { MAX_SUB_ISSUES, measureDepth, validatePlan } from './plan-validation.mjs';

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 * @typedef {import('./plan-validation.mjs').Plan} Plan
 * @typedef {import('./plan-validation.mjs').PlanTask} PlanTask
 */

/**
 * 計画から作成した (または作成済みの) Issue
 * @typedef {object} PlannedIssue
 * @property {string} id Node ID
 * @property {number} number Issue 番号
 * @property {string} body 本文
 * @property {{ nodes: { login: string }[] }} assignees Assignee の一覧
 * @property {{ nodes: { id: string }[] }} blockedBy この Issue を Blocking している Issue の一覧
 * @property {{ totalCount: number }} subIssues Sub Issue の数
 */

/**
 * @typedef {object} DesignIssue
 * @property {string} id Node ID
 * @property {number} number Issue 番号
 * @property {{ totalCount: number, nodes: PlannedIssue[] }} subIssues Sub Issue の一覧
 */

/**
 * DESIGN_ISSUE_QUERY の応答
 * @typedef {object} DesignIssueQueryResult
 * @property {{ id: string, issue: DesignIssue | null }} repository
 */

/**
 * SUB_ISSUES_QUERY の応答
 * @typedef {object} SubIssuesQueryResult
 * @property {{ subIssues: { nodes: PlannedIssue[] } } | null} node
 */

/**
 * CREATE_ISSUE_MUTATION の応答
 * @typedef {object} CreateIssueResult
 * @property {{ issue: PlannedIssue }} createIssue
 */

/** エージェントの識別子と、対応する Assignee を設定した環境変数の名前 */
const AGENT_VARIABLES = /** @type {const} */ ({
  'claude-code': 'CLAUDE_CODE_ASSIGNEE',
  codex: 'CODEX_ASSIGNEE',
  jules: 'JULES_ASSIGNEE',
});

const PLANNED_ISSUE_FIELDS = `
  fragment PlannedIssue on Issue {
    id
    number
    body
    assignees(first: 20) { nodes { login } }
    blockedBy(first: 100) { nodes { id } }
    subIssues { totalCount }
  }
`;

const DESIGN_ISSUE_QUERY = `
  ${PLANNED_ISSUE_FIELDS}
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      id
      issue(number: $number) {
        id
        number
        subIssues(first: 100) {
          totalCount
          nodes { ...PlannedIssue }
        }
      }
    }
  }
`;

const SUB_ISSUES_QUERY = `
  ${PLANNED_ISSUE_FIELDS}
  query ($id: ID!) {
    node(id: $id) {
      ... on Issue {
        subIssues(first: 100) { nodes { ...PlannedIssue } }
      }
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  ${PLANNED_ISSUE_FIELDS}
  mutation ($repositoryId: ID!, $title: String!, $body: String!, $parentIssueId: ID!) {
    createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, parentIssueId: $parentIssueId }) {
      issue { ...PlannedIssue }
    }
  }
`;

const ADD_BLOCKED_BY_MUTATION = `
  mutation ($issueId: ID!, $blockingIssueId: ID!) {
    addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
      issue { id }
    }
  }
`;

/** Sub Issue の API はプレビュー期間中にこのヘッダーを要求していたため、互換性のために付与する */
const GRAPHQL_HEADERS = { 'GraphQL-Features': 'sub_issues' };

/** 短時間に大量の Issue を作成すると二次レート制限にかかるため、書き込みの間隔を空ける */
const WRITE_INTERVAL_MS = 1000;

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function applyPlan({ github, context, core }) {
  const designIssueNumber = Number.parseInt(process.env.DESIGN_ISSUE_NUMBER ?? '', 10);
  const maxTasks = Number.parseInt(process.env.MAX_TASKS ?? '', 10) || 30;
  const assignees = readAgentAssignees();
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const markerPrefix = `coding-agent-plan:${context.runId}:`;

  /** @type {unknown} */
  const input = JSON.parse(await readFile(process.env.PLAN_PATH ?? '', 'utf8'));

  /** @type {DesignIssueQueryResult} */
  const result = await github.graphql(DESIGN_ISSUE_QUERY, {
    ...context.repo,
    number: designIssueNumber,
    headers: GRAPHQL_HEADERS,
  });
  const repositoryId = result.repository.id;
  const design = result.repository.issue;
  if (design === null) {
    core.setFailed(`設計 Issue #${designIssueNumber} が見つかりません`);
    return;
  }

  const existing = await collectPlannedIssues(github, design, markerPrefix);
  const existingRoots = design.subIssues.nodes.filter((node) => existing.has(parseMarker(node.body, markerPrefix) ?? '')).length;

  const errors = validatePlan(input, {
    agents: new Set(assignees.keys()),
    maxTasks,
    rootCapacity: MAX_SUB_ISSUES - design.subIssues.totalCount + existingRoots,
  });
  if (errors.length > 0) {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: design.number,
      body: [
        '🤖 計画に問題があったため、Issue を作成しませんでした。',
        '',
        ...errors.map((error) => `- ${error}`),
        '',
        `ワークフロー: ${runUrl}`,
      ].join('\n'),
    });
    core.setFailed(`計画に問題があります:\n${errors.join('\n')}`);
    return;
  }

  const plan = /** @type {Plan} */ (input);
  const issues = await createIssues({ github, core, plan, design, repositoryId, existing, markerPrefix, runUrl });
  await linkBlockers({ github, core, plan, issues });
  await assignAgents({ github, context, core, plan, issues, assignees });

  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: design.number,
    body: buildSummary(plan, issues, assignees, runUrl),
  });
}

/**
 * 設定されているエージェントと、対応する GitHub のログイン名を返す。
 *
 * @returns {Map<string, string>}
 */
function readAgentAssignees() {
  /** @type {Map<string, string>} */
  const assignees = new Map();
  for (const [agent, variable] of Object.entries(AGENT_VARIABLES)) {
    const login = (process.env[variable] ?? '').trim();
    if (login !== '') {
      assignees.set(agent, login);
    }
  }
  return assignees;
}

/**
 * 設計 Issue の配下をたどり、この実行で作成済みの Issue を集める。
 *
 * @param {AsyncFunctionArguments['github']} github
 * @param {DesignIssue} design
 * @param {string} markerPrefix
 * @returns {Promise<Map<string, PlannedIssue>>} タスクの key ごとの Issue
 */
async function collectPlannedIssues(github, design, markerPrefix) {
  /** @type {Map<string, PlannedIssue>} */
  const found = new Map();
  const queue = [...design.subIssues.nodes];

  while (queue.length > 0) {
    const issue = /** @type {PlannedIssue} */ (queue.shift());
    const key = parseMarker(issue.body, markerPrefix);
    if (key === undefined) {
      continue;
    }
    found.set(key, issue);

    if (issue.subIssues.totalCount > 0) {
      /** @type {SubIssuesQueryResult} */
      const result = await github.graphql(SUB_ISSUES_QUERY, { id: issue.id, headers: GRAPHQL_HEADERS });
      queue.push(...(result.node?.subIssues.nodes ?? []));
    }
  }

  return found;
}

/**
 * 親タスクから順に Issue を作成し、親 (または設計 Issue) の Sub Issue として紐づける。
 *
 * @param {object} args
 * @param {AsyncFunctionArguments['github']} args.github
 * @param {AsyncFunctionArguments['core']} args.core
 * @param {Plan} args.plan
 * @param {DesignIssue} args.design
 * @param {string} args.repositoryId
 * @param {Map<string, PlannedIssue>} args.existing 作成済みの Issue
 * @param {string} args.markerPrefix
 * @param {string} args.runUrl
 * @returns {Promise<Map<string, PlannedIssue>>} タスクの key ごとの Issue
 */
async function createIssues({ github, core, plan, design, repositoryId, existing, markerPrefix, runUrl }) {
  const issues = new Map(existing);
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  const ordered = [...plan.tasks].sort(
    (a, b) => (measureDepth(a, byKey) ?? 0) - (measureDepth(b, byKey) ?? 0),
  );

  for (const task of ordered) {
    if (issues.has(task.key)) {
      core.info(`"${task.key}" は作成済みです (#${issues.get(task.key)?.number})`);
      continue;
    }

    const parentId = task.parent === null ? design.id : issues.get(task.parent)?.id;
    if (parentId === undefined) {
      throw new Error(`"${task.key}" の親 Issue が作成されていません`);
    }

    /** @type {CreateIssueResult} */
    const result = await github.graphql(CREATE_ISSUE_MUTATION, {
      repositoryId,
      title: task.title,
      body: [
        task.body.trim(),
        '',
        '---',
        `🤖 このタスクは設計 Issue #${design.number} の実装計画から作成されました ([ワークフロー](${runUrl}))`,
        `<!-- ${markerPrefix}${task.key} -->`,
      ].join('\n'),
      parentIssueId: parentId,
      headers: GRAPHQL_HEADERS,
    });
    issues.set(task.key, result.createIssue.issue);
    core.info(`"${task.key}" を #${result.createIssue.issue.number} として作成しました`);
    await sleep(WRITE_INTERVAL_MS);
  }

  return issues;
}

/**
 * Blocked by の関係を設定する。設定済みの関係は飛ばす。
 *
 * @param {object} args
 * @param {AsyncFunctionArguments['github']} args.github
 * @param {AsyncFunctionArguments['core']} args.core
 * @param {Plan} args.plan
 * @param {Map<string, PlannedIssue>} args.issues タスクの key ごとの Issue
 * @returns {Promise<void>}
 */
async function linkBlockers({ github, core, plan, issues }) {
  for (const task of plan.tasks) {
    const issue = requireIssue(issues, task.key);
    const linked = new Set(issue.blockedBy.nodes.map((node) => node.id));

    for (const blockerKey of task.blocked_by) {
      const blocker = requireIssue(issues, blockerKey);
      if (linked.has(blocker.id)) {
        continue;
      }
      await github.graphql(ADD_BLOCKED_BY_MUTATION, { issueId: issue.id, blockingIssueId: blocker.id });
      core.info(`#${issue.number} を #${blocker.number} の完了待ちにしました`);
      await sleep(WRITE_INTERVAL_MS);
    }
  }
}

/**
 * 各タスクに担当エージェントのアカウントを Assign する。Assign 済みのタスクは飛ばす。
 *
 * @param {object} args
 * @param {AsyncFunctionArguments['github']} args.github
 * @param {AsyncFunctionArguments['context']} args.context
 * @param {AsyncFunctionArguments['core']} args.core
 * @param {Plan} args.plan
 * @param {Map<string, PlannedIssue>} args.issues タスクの key ごとの Issue
 * @param {Map<string, string>} args.assignees エージェントごとの GitHub のログイン名
 * @returns {Promise<void>}
 */
async function assignAgents({ github, context, core, plan, issues, assignees }) {
  for (const task of plan.tasks) {
    const login = task.agent === null ? undefined : assignees.get(task.agent);
    if (login === undefined) {
      continue;
    }

    const issue = requireIssue(issues, task.key);
    if (issue.assignees.nodes.some((node) => sameLogin(node.login, login))) {
      continue;
    }

    const { data } = await github.rest.issues.addAssignees({
      ...context.repo,
      issue_number: issue.number,
      assignees: [login],
    });
    // Assign できないアカウントを指定しても API はエラーにならないため、結果を確認する
    if (!data.assignees?.some((assignee) => sameLogin(assignee.login, login))) {
      throw new Error(`#${issue.number} に ${login} を Assign できませんでした (リポジトリのコラボレーターか確認してください)`);
    }
    core.info(`#${issue.number} に ${login} を Assign しました`);
    await sleep(WRITE_INTERVAL_MS);
  }
}

/**
 * 設計 Issue に残す、作成した Issue の一覧を組み立てる。
 *
 * @param {Plan} plan
 * @param {Map<string, PlannedIssue>} issues タスクの key ごとの Issue
 * @param {Map<string, string>} assignees エージェントごとの GitHub のログイン名
 * @param {string} runUrl
 * @returns {string}
 */
function buildSummary(plan, issues, assignees, runUrl) {
  const rows = plan.tasks.map((task) => {
    const issue = requireIssue(issues, task.key);
    const parent = task.parent === null ? '-' : `#${requireIssue(issues, task.parent).number}`;
    const blockers = task.blocked_by.map((key) => `#${requireIssue(issues, key).number}`).join(', ') || '-';
    const agent = task.agent === null ? '(人が対応)' : `${task.agent} (@${assignees.get(task.agent)})`;
    return `| #${issue.number} | ${agent} | ${parent} | ${blockers} |`;
  });

  return [
    `🤖 実装計画から ${plan.tasks.length} 件の Issue を作成しました。`,
    '',
    plan.summary.trim(),
    '',
    '| Issue | 担当 | 親 | 先に完了が必要 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `ワークフロー: ${runUrl}`,
  ].join('\n');
}

/**
 * @param {Map<string, PlannedIssue>} issues
 * @param {string} key
 * @returns {PlannedIssue}
 */
function requireIssue(issues, key) {
  const issue = issues.get(key);
  if (issue === undefined) {
    throw new Error(`"${key}" の Issue が作成されていません`);
  }
  return issue;
}

/**
 * 本文のマーカーから、タスクの key を取り出す。
 *
 * @param {string} body
 * @param {string} markerPrefix
 * @returns {string | undefined} この実行のマーカーが無い場合は undefined
 */
function parseMarker(body, markerPrefix) {
  const start = body.indexOf(`<!-- ${markerPrefix}`);
  if (start === -1) {
    return undefined;
  }
  const rest = body.slice(start + `<!-- ${markerPrefix}`.length);
  const end = rest.indexOf(' -->');
  return end === -1 ? undefined : rest.slice(0, end);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameLogin(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
