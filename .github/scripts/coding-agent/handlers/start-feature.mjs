/**
 * 機能の開始: 「新規機能」の Issue フォームで作られた機能の親 Issue に、段階の Issue を作成する。
 *
 * 段階の Issue は、機能の親 Issue の Sub Issue として横並びに作り、Blocked by で順につなぐ。
 * 担当の Assign とラベル (agent:<識別子>) は最後に付け、依存関係を設定する前にエージェントが起動しないようにする。
 * 作成済みの段階の Issue や関係は飛ばすため、途中で失敗しても、もう一度実行すれば続きから処理する。
 *
 * 本文の機能名が正しくなければ段階の Issue を作らずに知らせ、本文が編集されたときに改めて処理する。
 */

import { agentLabel, featureDirectory, getAuthor, isCoordinator, isValidFeatureName, MAX_FEATURE_NAME_LENGTH } from '../config.mjs';
import { addBlockedBy, addSubIssue, ensureAgentLabels, getBlockedBy, hasLabel, hasWritePermission, listSubIssues } from '../github-issues.mjs';
import { FEATURE_NAME_FIELD, parseIssueForm } from '../issue-form.mjs';
import { FEATURE_LABEL, FEATURE_STAGES, stageIssueBody, stageLabel, stageOf } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../github-issues.mjs').RestIssue} RestIssue
 */

/** @type {Handler} */
export const startFeature = {
  name: '機能の開始',
  events: ['issues.opened', 'issues.edited'],
  matches: async ({ context }) => {
    const issue = context.payload.issue;
    return issue?.state === 'open' && hasLabel(issue.labels ?? [], FEATURE_LABEL);
  },
  run: async ({ github, context, core, config }) => {
    const repository = context.repo;
    /** @type {RestIssue & { body?: string | null }} */
    const feature = context.payload.issue;
    const author = feature.user?.login ?? '';

    // 書き込み権限の無いユーザーが作った Issue では、段階の Issue を作らない
    if (!(await hasWritePermission(github, repository, author))) {
      core.notice(`#${feature.number} の作成者 ${author} は書き込み権限を持たないため、段階の Issue を作成しません`);
      return {};
    }

    const existing = (await listSubIssues(github, repository, feature.number)).filter((issue) =>
      isCoordinator(config.agents, issue.user?.login),
    );
    const isStarted = existing.some((issue) => stageOf(issue.labels) !== undefined);
    // 段階の Issue を作り始めた後の編集では、機能名 (成果物のディレクトリ) を変えない
    if (context.payload.action === 'edited' && isStarted) {
      core.info(`#${feature.number} の段階の Issue は作成済みのため、編集では何もしません`);
      return {};
    }

    const featureName = parseIssueForm(feature.body).get(FEATURE_NAME_FIELD) ?? '';
    if (!isValidFeatureName(featureName)) {
      if (context.payload.action === 'opened') {
        await github.rest.issues.createComment({
          ...repository,
          issue_number: feature.number,
          body: [
            `🤖 機能名「${featureName.slice(0, 100)}」の形式が正しくないため、段階の Issue を作成していません。`,
            '',
            `本文の「### ${FEATURE_NAME_FIELD}」の下を、英小文字・数字とハイフンで ${MAX_FEATURE_NAME_LENGTH} 文字以内の名前 (例: \`user-login\`) に直してください。本文を保存すると、段階の Issue を作成します。`,
          ].join('\n'),
        });
      }
      core.notice(`#${feature.number} の機能名の形式が正しくないため、段階の Issue を作成しません`);
      return {};
    }
    const featureDir = featureDirectory(config.stages, feature.number, featureName);

    // 段階の Issue を作成し、機能の親 Issue の Sub Issue にする
    /** @type {RestIssue[]} */
    const stageIssues = [];
    /** @type {RestIssue[]} */
    const created = [];
    for (const stage of FEATURE_STAGES) {
      let issue = existing.find((candidate) => stageOf(candidate.labels) === stage.id);
      if (issue === undefined) {
        const { data } = await github.rest.issues.create({
          ...repository,
          title: `${stage.name}: ${feature.title}`,
          body: stageIssueBody({ stage, featureIssueNumber: feature.number, featureDir }),
          labels: [stageLabel(stage.id)],
        });
        issue = /** @type {RestIssue} */ (data);
        await addSubIssue(github, repository, feature.number, issue.id);
        created.push(issue);
        core.info(`#${issue.number} (${stage.name}) を作成しました`);
      }
      stageIssues.push(issue);
    }

    // 前の段階の Issue に Blocked by でつなぐ
    for (let index = 1; index < stageIssues.length; index++) {
      const [blocking, blocked] = [stageIssues[index - 1], stageIssues[index]];
      if (!(await getBlockedBy(github, repository, blocked.number)).includes(blocking.number)) {
        await addBlockedBy(github, blocked.node_id, blocking.node_id);
      }
    }

    // 最後に担当を決める。要件定義は機能の親 Issue の作成者を Assign し、ほかの段階は作成担当のラベルを付ける
    await ensureAgentLabels(
      github,
      repository,
      FEATURE_STAGES.filter((stage) => stage.id !== 'requirements').map((stage) => getAuthor(config.agents, stage.id).agent),
    );
    /** @type {string[]} */
    const lines = [];
    for (const [index, stage] of FEATURE_STAGES.entries()) {
      const issue = stageIssues[index];
      if (stage.id === 'requirements') {
        // 作成者は書き込み権限を持つことを確かめてあるため、Assign できる
        await github.rest.issues.addAssignees({ ...repository, issue_number: issue.number, assignees: [author] });
        lines.push(`- #${issue.number} ${stage.name} (担当: \`${author}\`)`);
      } else {
        const { agent } = getAuthor(config.agents, stage.id);
        await github.rest.issues.addLabels({ ...repository, issue_number: issue.number, labels: [agentLabel(agent.id)] });
        lines.push(`- #${issue.number} ${stage.name} (担当: ${agent.name})`);
      }
    }

    if (created.length > 0) {
      await github.rest.issues.createComment({
        ...repository,
        issue_number: feature.number,
        body: [
          '🤖 段階の Issue を作成しました。前の段階が完了すると、次の段階が始まります。',
          '',
          ...lines,
          '',
          `成果物は \`${featureDir}/\` に置きます。まずは要件定義書を作成してください。`,
        ].join('\n'),
      });
    }
    return {};
  },
};
