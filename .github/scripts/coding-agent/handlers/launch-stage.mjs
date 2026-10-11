/**
 * 段階の起動: 前の段階が完了したら、次の段階の作成担当に、成果物の作成を依頼する。
 *
 * - wakeWaitingStages: Issue が Close されたら、それを待っていた Issue (親 Issue と Blocking していた Issue) のうち、
 *   起動できるものごとに振り分けをやり直す。1 回の Close で複数の Issue が起動できるようになることがあり、
 *   Issue ごとの concurrency で処理を 1 つずつに絞るため
 * - launchStage: Issue が Assign されたときや、振り分けをやり直したとき (手動実行を含む) に、起動の条件を確かめて
 *   作成を依頼する。同じ Issue では、二重に起動しないよう、Issue に印となるコメントを残す
 *
 * 起動の条件は、次のすべてを満たすこと。
 * - 進行役の App が作った、Open の段階の Issue で、その段階の作成担当が Assign されている
 * - すべての依存先 (Sub Issue と Blocked by の Issue) が Close され、紐づく PR に Open のまま残っているものが無い
 *
 * 今は、文書の段階 (仕様書、概念モデル、アーキテクチャ設計) だけを起動する。実装計画と実装タスクは、後で対応する。
 */

import { isTrustedActor } from '../actors.mjs';
import { expandStageFiles, featureDirectory, findAgentByAssignee, getAgent, isCoordinator, isValidFeatureName } from '../config.mjs';
import { findLabeledAncestor, findUnresolvedDependencies, findWaitingIssueNumbers } from '../github-issues.mjs';
import { FEATURE_NAME_FIELD, parseIssueForm } from '../issue-form.mjs';
import { artifactPath, FEATURE_LABEL, getFeatureStage, reviewDocuments, stageOf } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../route.mjs').HandlerArgs} HandlerArgs
 * @typedef {import('../github-issues.mjs').RestIssue} RestIssue
 * @typedef {import('../config.mjs').CodingAgentConfig} CodingAgentConfig
 */

/** 作成担当が成果物を作る段階 (今対応しているもの) */
export const CREATABLE_STAGES = /** @type {const} */ (['specification', 'domain-model', 'architecture']);

/** 起動済みの印として、Issue のコメントに埋め込む文字列 */
export const LAUNCH_MARKER = '<!-- coding-agent-launch -->';

/**
 * 段階の Issue を起動できるか確かめる。
 *
 * @param {HandlerArgs} args
 * @param {RestIssue} issue
 * @returns {Promise<{ stage: typeof CREATABLE_STAGES[number], agent: import('../config.mjs').RegisteredAgent } | { reason: string }>}
 */
async function checkLaunchable({ github, context, config }, issue) {
  if (issue.state !== 'open') {
    return { reason: 'Close されています' };
  }
  const stage = stageOf(issue.labels);
  if (!isCoordinator(config.agents, issue.user?.login) || stage === undefined) {
    return { reason: '段階の Issue ではありません' };
  }
  if (!CREATABLE_STAGES.includes(/** @type {typeof CREATABLE_STAGES[number]} */ (stage))) {
    return { reason: `「${stage}」の段階の起動には、まだ対応していません` };
  }
  const creatable = /** @type {typeof CREATABLE_STAGES[number]} */ (stage);
  const agent = getAgent(config.agents, config.agents.roles.author[creatable]);
  if (!(issue.assignees ?? []).some((user) => user.login.toLowerCase() === agent.assignee.toLowerCase())) {
    return { reason: `作成担当 (${agent.assignee}) が Assign されていません` };
  }
  const unresolved = await findUnresolvedDependencies(github, context.repo, issue.number);
  if (unresolved.length > 0) {
    return { reason: `依存先が解決していません: ${unresolved.join('、')}` };
  }
  return { stage: creatable, agent };
}

/** @type {Handler} */
export const wakeWaitingStages = {
  name: '待っていた段階の起動',
  events: ['issues.closed'],
  run: async (args) => {
    const { github, context, core } = args;
    if (!(await isTrustedActor(args))) {
      core.notice(`${context.actor} は書き込み権限を持たないため、待っていた段階を起動しません`);
      return {};
    }

    /** @type {number[]} */
    const redispatch = [];
    for (const number of await findWaitingIssueNumbers(github, context.repo, context.payload.issue.number)) {
      const { data } = await github.rest.issues.get({ ...context.repo, issue_number: number });
      const result = await checkLaunchable(args, /** @type {RestIssue} */ (data));
      if ('reason' in result) {
        core.info(`#${number} は起動しません: ${result.reason}`);
      } else {
        redispatch.push(number);
      }
    }
    return { redispatch };
  },
};

/** @type {Handler} */
export const launchStage = {
  name: '段階の起動',
  events: ['issues.assigned', 'workflow_dispatch'],
  matches: async ({ context, config }) => {
    // Assign されたのが、作成担当のエージェントのときだけ処理する
    if (context.eventName === 'issues') {
      return findAgentByAssignee(config.agents, context.payload.assignee?.login) !== undefined;
    }
    return true;
  },
  run: async (args) => {
    const { github, context, core, config } = args;
    const repository = context.repo;
    const isDispatch = context.eventName === 'workflow_dispatch';
    const issueNumber = isDispatch ? Number.parseInt(String(context.payload.inputs?.['issue-number'] ?? ''), 10) : context.payload.issue.number;
    const force = isDispatch && String(context.payload.inputs?.force) === 'true';
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      core.setFailed(`Issue の番号が正しくありません: ${context.payload.inputs?.['issue-number']}`);
      return {};
    }
    if (!(await isTrustedActor(args))) {
      core.notice(`${context.actor} は書き込み権限を持たないため、#${issueNumber} を起動しません`);
      return {};
    }

    const { data } = await github.rest.issues.get({ ...repository, issue_number: issueNumber });
    const issue = /** @type {RestIssue & { body?: string | null, pull_request?: object }} */ (data);
    if (issue.pull_request !== undefined) {
      return {};
    }
    const result = await checkLaunchable(args, issue);
    if ('reason' in result) {
      core.info(`#${issueNumber} は起動しません: ${result.reason}`);
      return {};
    }
    const { stage, agent } = result;

    // 同じ Issue では二重に起動しない (force を指定した手動実行では起動し直す)
    /** @type {{ user: { login: string } | null, body?: string }[]} */
    const comments = await github.paginate(github.rest.issues.listComments, { ...repository, issue_number: issueNumber, per_page: 100 });
    const launched = comments.some((comment) => isCoordinator(config.agents, comment.user?.login) && comment.body?.includes(LAUNCH_MARKER));
    if (launched && !force) {
      core.notice(`#${issueNumber} は起動済みのため、起動しません (起動し直す場合は、force を有効にして手動実行してください)`);
      return {};
    }

    const feature = await findLabeledAncestor(github, repository, issueNumber, FEATURE_LABEL);
    const featureName = feature === undefined ? '' : (parseIssueForm(feature.body).get(FEATURE_NAME_FIELD) ?? '');
    if (feature === undefined || !isValidFeatureName(featureName)) {
      core.warning(`#${issueNumber} の機能の親 Issue か、その機能名が見つからないため、起動しません`);
      return {};
    }
    const featureDir = featureDirectory(config.stages, feature.number, featureName);

    // 既定ブランチの最新のコミットから作業を始める
    const defaultBranch = /** @type {string} */ (context.payload.repository?.default_branch);
    const { data: branch } = await github.rest.repos.getBranch({ ...repository, branch: defaultBranch });

    const name = getFeatureStage(stage).name;
    await github.rest.issues.createComment({
      ...repository,
      issue_number: issueNumber,
      body: `🤖 ${agent.name} に「${name}」の作成を依頼しました。作成された PR は、レビュー担当がレビューします。\n\n${LAUNCH_MARKER}`,
    });
    core.info(`#${issueNumber} (${name}) の作成を ${agent.name} に依頼します`);

    return {
      requests: [
        {
          id: `create-issue-${issueNumber}`,
          agent: agent.id,
          mode: 'create',
          stage,
          issueNumber,
          pullRequestNumber: null,
          targetSha: branch.commit.sha,
          materials: {
            issue: { number: issue.number, title: issue.title, body: issue.body ?? '' },
            feature: { number: feature.number, title: feature.title, body: feature.body ?? '' },
            featureDir,
            artifact: artifactPath(stage, featureDir),
            documents: reviewDocuments(stage, featureDir),
            allowedFiles: expandStageFiles(config.stages, stage, featureDir),
          },
        },
      ],
    };
  },
};
