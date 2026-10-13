/**
 * 実装計画の作成担当が出力した計画を検証し、進行役の GitHub App で実装タスクの Issue を作成する。
 *
 * エージェントが依存関係を設定する前に起動しないよう、次の順番で処理する。
 * 1. すべての Issue を親タスクから順に作成し、Sub Issue として紐づける (担当のラベルなし)
 * 2. Blocked by の関係を設定する
 * 3. 最後に担当のラベル (agent:<識別子>) を付ける (ここで、依存先の無いタスクが起動する)
 *
 * 本文に埋め込んだ印 (実行の ID とタスクの key) で作成済みの Issue を見分けるため、
 * 途中で失敗しても、同じ実行を再実行すれば続きから処理する。
 *
 * 環境変数:
 * - GITHUB_WORKSPACE: リポジトリのルート (設定ファイルの読み込みに使う)
 * - PLAN_PATH: 計画 (JSON) のファイルパス
 * - PLANNING_ISSUE_NUMBER: 実装計画の Issue の番号
 * - MAX_TASKS: 1 回の計画で作成できるタスクの上限 (Variables の PLANNER_MAX_TASKS。未設定なら 30)
 * - PLAN_RUN_ID: 計画を作成した実行の ID (作成済みの Issue を見分ける印に使う)
 * - RUN_URL: ワークフローの実行の URL
 */

import { readFile } from 'node:fs/promises';
import { agentLabel, ConfigError, getAgent, getImplementers, isCoordinator, loadConfig } from './config.mjs';
import { addBlockedBy, addSubIssue, ensureAgentLabels, getBlockedBy, listSubIssues, measureIssueDepth } from './github-issues.mjs';
import { MAX_SUB_ISSUE_LEVELS, MAX_SUB_ISSUES, measureDepth, validatePlan } from './plan-validation.mjs';
import { IMPLEMENTATION_STAGE, stageLabel, stageOf } from './stages.mjs';

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 * @typedef {import('./plan-validation.mjs').Plan} Plan
 * @typedef {import('./plan-validation.mjs').PlanTask} PlanTask
 * @typedef {import('./github-issues.mjs').RestIssue} RestIssue
 */

/** 計画のタスクの上限の既定値 */
export const DEFAULT_MAX_TASKS = 30;

/**
 * 計画のタスクの上限を返す。Variables の PLANNER_MAX_TASKS が正しくなければ、既定値を使う。
 *
 * @param {string | undefined} value
 * @returns {number}
 */
export function maxPlanTasks(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value?.trim() ? parsed : DEFAULT_MAX_TASKS;
}

/**
 * 作成した Issue の本文に埋め込む印を返す。
 *
 * @param {string} runId 計画を作成した実行の ID
 * @param {string} key タスクの key
 * @returns {string}
 */
export function taskMarker(runId, key) {
  return `<!-- coding-agent-plan:${runId}:${key} -->`;
}

/**
 * Issue の本文から、この実行で作成したタスクの key を取り出す。
 *
 * @param {string | null | undefined} body
 * @param {string} runId
 * @returns {string | undefined}
 */
export function parseTaskMarker(body, runId) {
  const match = new RegExp(`<!-- coding-agent-plan:${runId}:([a-z0-9][a-z0-9-]{0,49}) -->`).exec(body ?? '');
  return match?.[1];
}

/**
 * @param {AsyncFunctionArguments & { writeIntervalMs?: number }} args
 * @returns {Promise<void>}
 */
export default async function createTasks({ github, context, core, writeIntervalMs = 1000 }) {
  const repository = context.repo;
  const planningNumber = Number.parseInt(process.env.PLANNING_ISSUE_NUMBER ?? '', 10);
  const runId = process.env.PLAN_RUN_ID ?? '';
  const maxTasks = maxPlanTasks(process.env.MAX_TASKS);
  const runUrl = process.env.RUN_URL ?? '';
  // GitHub の二次的なレート制限を避けるため、書き込みの間を空ける
  const pause = () => new Promise((resolve) => setTimeout(resolve, writeIntervalMs));

  let config;
  try {
    config = await loadConfig(process.env.GITHUB_WORKSPACE ?? process.cwd());
  } catch (error) {
    if (error instanceof ConfigError) {
      core.setFailed(error.message);
      return;
    }
    throw error;
  }

  // 実装計画の Issue を確かめる
  const { data: planningData } = await github.rest.issues.get({ ...repository, issue_number: planningNumber });
  const planning = /** @type {RestIssue} */ (planningData);
  if (planning.state !== 'open' || stageOf(planning.labels) !== 'planning' || !isCoordinator(config.agents, planning.user?.login)) {
    core.setFailed(`#${planningNumber} は、Open の実装計画の Issue ではありません`);
    return;
  }

  /** @type {unknown} */
  let input;
  try {
    input = JSON.parse(await readFile(process.env.PLAN_PATH ?? '', 'utf8'));
  } catch (error) {
    core.setFailed(`計画を読み込めません: ${error instanceof Error ? error.message : error}`);
    return;
  }

  // この実行で作成済みの Issue を、本文の印で見分ける
  const subIssues = await listSubIssues(github, repository, planningNumber);
  /** @type {Map<string, RestIssue>} */
  const existing = new Map();
  /** @param {RestIssue[]} issues */
  const collect = async (issues) => {
    for (const issue of issues) {
      const key = parseTaskMarker(/** @type {RestIssue & { body?: string }} */ (issue).body, runId);
      if (key !== undefined && isCoordinator(config.agents, issue.user?.login)) {
        existing.set(key, issue);
        await collect(await listSubIssues(github, repository, issue.number));
      }
    }
  };
  await collect(subIssues);
  const otherRoots = subIssues.filter((issue) => parseTaskMarker(/** @type {RestIssue & { body?: string }} */ (issue).body, runId) === undefined).length;

  const planningDepth = await measureIssueDepth(github, repository, planningNumber);
  const errors = validatePlan(input, {
    agents: new Set(getImplementers(config.agents).map((implementer) => implementer.agent.id)),
    maxTasks,
    maxDepth: MAX_SUB_ISSUE_LEVELS - planningDepth,
    rootCapacity: MAX_SUB_ISSUES - otherRoots,
  });
  if (errors.length > 0) {
    await github.rest.issues.createComment({
      ...repository,
      issue_number: planningNumber,
      body: [
        '🤖 実装計画に問題があるため、実装タスクの Issue を作成しませんでした。',
        '',
        ...errors.map((error) => `- ${error}`),
        '',
        `詳細は [ワークフロー](${runUrl}) のログを確認してください。計画を作り直す場合は、振り分け用のワークフローを、この Issue の番号を指定し force を有効にして手動実行してください。`,
      ].join('\n'),
    });
    core.setFailed(`実装計画に問題があります:\n${errors.join('\n')}`);
    return;
  }
  const plan = /** @type {Plan} */ (input);
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));

  // 1. 親タスクから順に Issue を作成し、Sub Issue にする
  const ordered = [...plan.tasks].sort((a, b) => (measureDepth(a, byKey) ?? 0) - (measureDepth(b, byKey) ?? 0));
  /** @type {Map<string, RestIssue>} */
  const issues = new Map(existing);
  for (const task of ordered) {
    if (issues.has(task.key)) {
      continue;
    }
    const { data } = await github.rest.issues.create({
      ...repository,
      title: task.title,
      body: `${task.body.trim()}\n\n---\n🤖 #${planningNumber} の実装計画から作成しました ([ワークフロー](${runUrl}))。\n\n${taskMarker(runId, task.key)}\n`,
      labels: [stageLabel(IMPLEMENTATION_STAGE)],
    });
    const issue = /** @type {RestIssue} */ (data);
    const parentNumber = task.parent === null ? planningNumber : /** @type {RestIssue} */ (issues.get(task.parent)).number;
    await addSubIssue(github, repository, parentNumber, issue.id);
    issues.set(task.key, issue);
    core.info(`#${issue.number} (${task.key}) を作成しました`);
    await pause();
  }

  // 2. Blocked by の関係を設定する
  for (const task of plan.tasks) {
    const issue = /** @type {RestIssue} */ (issues.get(task.key));
    const current = await getBlockedBy(github, repository, issue.number);
    for (const blockerKey of task.blocked_by) {
      const blocker = /** @type {RestIssue} */ (issues.get(blockerKey));
      if (!current.includes(blocker.number)) {
        await addBlockedBy(github, issue.node_id, blocker.node_id);
        await pause();
      }
    }
  }

  // 3. 最後に担当のラベルを付ける
  await ensureAgentLabels(
    github,
    repository,
    plan.tasks.flatMap((task) => (task.agent === null ? [] : [getAgent(config.agents, task.agent)])),
  );
  /** @type {string[]} */
  const lines = [];
  for (const task of plan.tasks) {
    const issue = /** @type {RestIssue} */ (issues.get(task.key));
    if (task.agent === null) {
      lines.push(`- #${issue.number} ${task.title} (担当: 人)`);
      continue;
    }
    const agent = getAgent(config.agents, task.agent);
    await github.rest.issues.addLabels({ ...repository, issue_number: issue.number, labels: [agentLabel(agent.id)] });
    lines.push(`- #${issue.number} ${task.title} (担当: ${agent.name})`);
    await pause();
  }

  await github.rest.issues.createComment({
    ...repository,
    issue_number: planningNumber,
    body: [
      '🤖 実装計画から、実装タスクの Issue を作成しました。依存先が完了したタスクから、担当が実装します。',
      '',
      '## 計画の概要',
      '',
      plan.summary.trim(),
      '',
      '## 実装タスク',
      '',
      ...lines,
      '',
      '担当が「人」のタスクは、人が対応して Close してください。',
    ].join('\n'),
  });
  core.info(`${plan.tasks.length} 件の実装タスクを作成しました`);
}
