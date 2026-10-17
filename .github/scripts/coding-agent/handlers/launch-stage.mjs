/**
 * 段階の起動: 前の段階が完了したら、次の段階の作成担当に、成果物の作成を依頼する。
 *
 * - wakeWaitingStages: Issue が Close されたら、それを待っていた Issue (親 Issue と Blocking していた Issue) のうち、
 *   起動できるものごとに振り分けをやり直す。1 回の Close で複数の Issue が起動できるようになることがあり、
 *   Issue ごとの concurrency で処理を 1 つずつに絞るため
 * - launchStage: Issue に担当のラベル (agent:<識別子>) が付いたときや、振り分けをやり直したとき (手動実行を含む) に、
 *   起動の条件を確かめて作成を依頼する。同じ Issue では、二重に起動しないよう、Issue に印となるコメントを残す
 *
 * 起動の条件は、次のすべてを満たすこと。
 * - 進行役の App が作った、Open の段階の Issue で、その段階の作成担当のラベルが付いている
 *   - 文書の段階、プロジェクトの作成、実装計画の作成担当は、agents.json の roles.<段階>.author で決まる
 *   - 実装タスクの作成担当は、roles.implementation.implementers のうち、Issue にラベルが付いているエージェント (実装計画で割り当てたもの)
 * - すべての依存先 (Sub Issue と Blocked by の Issue) が Close され、紐づく PR に Open のまま残っているものが無い
 */

import { fetchCriteriaFile, readAssignment } from '../acceptance-criteria.mjs';
import { isTrustedActor } from '../actors.mjs';
import { agentLabel, expandStageFiles, featureDirectory, findAgentByLabel, getAuthor, getImplementers, isCoordinator, isValidFeatureName } from '../config.mjs';
import { maxPlanTasks } from '../create-tasks.mjs';
import { findLabeledAncestor, findUnresolvedDependencies, findWaitingIssueNumbers, hasLabel, measureIssueDepth } from '../github-issues.mjs';
import { MAX_SUB_ISSUE_LEVELS } from '../plan-validation.mjs';
import { FEATURE_NAME_FIELD, parseIssueForm } from '../issue-form.mjs';
import { stageName } from '../prompt-format.mjs';
import { NEEDS_HUMAN_LABEL } from '../stage-context.mjs';
import { isHandOverRequested } from './hand-over.mjs';
import { artifactPath, FEATURE_LABEL, IMPLEMENTATION_STAGE, reviewDocuments, sharedArtifactPaths, stageOf } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../route.mjs').HandlerArgs} HandlerArgs
 * @typedef {import('../github-issues.mjs').RestIssue} RestIssue
 * @typedef {import('../config.mjs').CodingAgentConfig} CodingAgentConfig
 * @typedef {import('../config.mjs').ResolvedAssignment} ResolvedAssignment
 */

/** 作成担当が成果物を作る段階 */
export const CREATABLE_STAGES = /** @type {const} */ (['specification', 'domain-model', 'architecture', 'project', 'planning', 'implementation']);

/** 起動済みの印として、Issue のコメントに埋め込む文字列 */
export const LAUNCH_MARKER = '<!-- coding-agent-launch -->';

/**
 * 段階の Issue を起動できるか確かめる。
 *
 * @param {HandlerArgs} args
 * @param {RestIssue} issue
 * @returns {Promise<{ stage: typeof CREATABLE_STAGES[number], author: ResolvedAssignment } | { reason: string }>}
 */
async function checkLaunchable({ github, context, config }, issue) {
  if (issue.state !== 'open') {
    return { reason: 'Close されています' };
  }
  const stage = stageOf(issue.labels);
  if (!isCoordinator(config.agents, issue.user?.login) || stage === undefined) {
    return { reason: '段階の Issue ではありません' };
  }
  // 人に引き継いだ Issue は、人が needs-human ラベルを外すまで起動しない (仕様の 6.4)
  if (hasLabel(issue.labels, NEEDS_HUMAN_LABEL)) {
    return { reason: `${NEEDS_HUMAN_LABEL} ラベルが付いています (人が対応してラベルを外すまで起動しません)` };
  }
  if (!CREATABLE_STAGES.includes(/** @type {typeof CREATABLE_STAGES[number]} */ (stage))) {
    return { reason: `「${stage}」の段階の起動には、まだ対応していません` };
  }
  const creatable = /** @type {typeof CREATABLE_STAGES[number]} */ (stage);
  // 担当のラベル (agent:<識別子>) が付いているエージェント
  const labeled = new Set(
    issue.labels.flatMap((label) => findAgentByLabel(config.agents, typeof label === 'string' ? label : label.name)?.id ?? []),
  );
  /** @type {ResolvedAssignment} */
  let author;
  if (creatable === IMPLEMENTATION_STAGE) {
    // 実装タスクは、実装計画で割り当てたエージェント (ラベルの付いている実装担当) が作成する
    const candidates = getImplementers(config.agents).filter((implementer) => labeled.has(implementer.agent.id));
    if (candidates.length !== 1) {
      return {
        reason:
          candidates.length === 0
            ? '実装担当のエージェントのラベルが付いていません (人が対応するタスクか、子タスクをまとめるタスクです)'
            : `実装担当のエージェントのラベルが複数付いています: ${candidates.map((candidate) => agentLabel(candidate.agent.id)).join('、')}`,
      };
    }
    author = candidates[0];
  } else {
    author = getAuthor(config.agents, creatable);
    if (!labeled.has(author.agent.id)) {
      return { reason: `作成担当のラベル (${agentLabel(author.agent.id)}) が付いていません` };
    }
  }
  const unresolved = await findUnresolvedDependencies(github, context.repo, issue.number);
  if (unresolved.length > 0) {
    return { reason: `依存先が解決していません: ${unresolved.join('、')}` };
  }
  return { stage: creatable, author };
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
  events: ['issues.labeled', 'workflow_dispatch'],
  matches: async ({ context, config }) => {
    // 付いたのが、登録済みのエージェントのラベルのときだけ処理する
    if (context.eventName === 'issues') {
      return findAgentByLabel(config.agents, context.payload.label?.name) !== undefined;
    }
    // 人への引き継ぎを依頼する手動実行は、人への引き継ぎ (hand-over.mjs) だけが扱う
    return !isHandOverRequested(context);
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
    const { stage, author } = result;
    const { agent } = author;

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

    // 実装計画と実装タスクでは、作業を始めるコミットの受け入れ基準を読む (仕様の 10.4)
    /** @type {string[] | null} */
    let acceptanceCriteria = null;
    if (stage === 'planning' || stage === IMPLEMENTATION_STAGE) {
      const criteria = await fetchCriteriaFile({ github, repository, ref: branch.commit.sha, featureDir, feature: feature.number });
      /** @type {string | undefined} */
      let problem;
      if ('errors' in criteria) {
        problem = ['受け入れ基準のファイルが形式を満たしていません。', '', ...criteria.errors.map((error) => `- ${error}`)].join('\n');
      } else if (criteria.file !== null) {
        if (stage === 'planning') {
          acceptanceCriteria = criteria.file.criteria.map((criterion) => criterion.id);
        } else {
          // 実装タスクでは、本文の割り当ての印を厳密に読む。人が本文を壊した場合などは起動しない
          const assignment = readAssignment(issue.body, criteria.file);
          if ('reason' in assignment) {
            problem = `${assignment.reason}。`;
          } else {
            acceptanceCriteria = assignment.ids;
          }
        }
      }
      if (problem !== undefined) {
        await github.rest.issues.createComment({
          ...repository,
          issue_number: issueNumber,
          body: `🤖 「${stageName(stage)}」を起動できませんでした。${problem}\n\n直したら、振り分け用のワークフローを、この Issue の番号を指定して手動実行してください。`,
        });
        core.warning(`#${issueNumber} は、受け入れ基準に問題があるため起動しません`);
        return {};
      }
    }

    const name = stageName(stage);
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
          execution: author.execution,
          materials: {
            issue: { number: issue.number, title: issue.title, body: issue.body ?? '' },
            feature: { number: feature.number, title: feature.title, body: feature.body ?? '' },
            featureDir,
            artifact: artifactPath(stage, featureDir),
            sharedArtifacts: sharedArtifactPaths(stage),
            documents: reviewDocuments(stage, featureDir),
            // 受け入れ基準の識別子。実装計画では機能のすべての識別子、実装タスクでは割り当てられた識別子 (ファイルが無い機能では null)
            acceptanceCriteria,
            ...(stage === 'planning'
              ? {
                  // 実装計画はファイルを変更せず、計画から実装タスクの Issue を作る
                  allowedFiles: null,
                  implementers: getImplementers(config.agents).map((implementer) => ({ id: implementer.agent.id, name: implementer.agent.name })),
                  planLimits: {
                    maxTasks: maxPlanTasks(process.env.PLANNER_MAX_TASKS),
                    maxDepth: MAX_SUB_ISSUE_LEVELS - (await measureIssueDepth(github, repository, issueNumber)),
                  },
                }
              : { allowedFiles: expandStageFiles(config.stages, stage, featureDir) }),
          },
        },
      ],
    };
  },
};
