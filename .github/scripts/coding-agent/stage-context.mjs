/**
 * PR が Close する段階の Issue と、その機能の情報 (成果物のディレクトリ、変更してよいファイルなど) を割り出す。
 * レビューの依頼と、修正の依頼で使う。
 */

import { expandStageFiles, featureDirectory, isCoordinator, isValidFeatureName } from './config.mjs';
import { findLabeledAncestor, hasLabel } from './github-issues.mjs';
import { getClosingIssueNumbers } from './github-pulls.mjs';
import { FEATURE_NAME_FIELD, parseIssueForm } from './issue-form.mjs';
import { artifactPath, FEATURE_LABEL, reviewDocuments, sharedArtifactPaths, stageOf } from './stages.mjs';

/**
 * @typedef {import('./github-issues.mjs').GitHub} GitHub
 * @typedef {import('./github-issues.mjs').Repository} Repository
 * @typedef {import('./github-issues.mjs').RestIssue} RestIssue
 */

/**
 * PR が Close する段階の情報
 * @typedef {object} StageContext
 * @property {RestIssue & { body?: string | null }} issue 段階の Issue
 * @property {import('./config.mjs').ReviewedStage} stage 段階
 * @property {RestIssue & { body?: string | null }} feature 機能の親 Issue
 * @property {string} featureDir 機能ごとのディレクトリ
 * @property {string | null} artifact 成果物のパス
 * @property {string[]} sharedArtifacts あわせて書き足す、機能をまたいで使う文書のパス
 * @property {{ name: string, path: string }[]} documents 参考資料
 * @property {{ allow: string[], deny: string[] }} allowedFiles 変更してよいファイルと、変更してはいけないファイル
 */

/** 人の対応が必要なことを表すラベル。付いている間は、レビューも修正も行わない */
export const NEEDS_HUMAN_LABEL = 'needs-human';

/**
 * PR が、仕組みで扱う PR (レビューや修正の対象) でない理由を返す。扱う PR なら undefined を返す。
 *
 * @param {{ state: string, draft?: boolean, labels?: (string | { name?: string })[], head: { repo?: { full_name: string } | null }, base: { ref: string, repo: { full_name: string } } }} pullRequest
 * @param {string | undefined} defaultBranch 既定ブランチ
 * @returns {string | undefined}
 */
export function unhandledReason(pullRequest, defaultBranch) {
  if (pullRequest.state !== 'open') {
    return 'Open ではありません';
  }
  if (pullRequest.draft) {
    return 'Draft です';
  }
  // フォークからの PR は対象にしない (Secrets を使うワークフローを、外部の変更に対して動かさないため)
  if (pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name) {
    return 'フォークからの PR です';
  }
  if (pullRequest.base.ref !== defaultBranch) {
    return '既定ブランチに向けた PR ではありません';
  }
  if (hasLabel(pullRequest.labels ?? [], NEEDS_HUMAN_LABEL)) {
    return `${NEEDS_HUMAN_LABEL} ラベルが付いています`;
  }
  return undefined;
}

/**
 * PR が Close する段階の Issue と、その機能の情報を割り出す。
 *
 * @param {object} args
 * @param {GitHub} args.github
 * @param {Repository} args.repository
 * @param {import('./config.mjs').CodingAgentConfig} args.config
 * @param {number} args.pullRequestNumber
 * @returns {Promise<{ context: StageContext } | { reason: string, closing: number[] }>} 割り出せなければ理由と、Close する Issue の番号
 */
export async function resolveStageContext({ github, repository, config, pullRequestNumber }) {
  const closing = await getClosingIssueNumbers(github, repository, pullRequestNumber);
  if (closing.length !== 1) {
    return { reason: closing.length === 0 ? 'Issue を Close しない PR です' : '複数の Issue を Close する PR です', closing };
  }

  const { data } = await github.rest.issues.get({ ...repository, issue_number: closing[0] });
  const issue = /** @type {RestIssue & { body?: string | null }} */ (data);
  const stage = stageOf(issue.labels);
  if (!isCoordinator(config.agents, issue.user?.login) || stage === undefined || stage === 'planning') {
    return { reason: `Close する #${issue.number} は段階の Issue ではありません`, closing };
  }

  // 機能ごとのディレクトリを、機能の親 Issue の機能名から決める
  const feature = await findLabeledAncestor(github, repository, issue.number, FEATURE_LABEL);
  const featureName = feature === undefined ? '' : (parseIssueForm(feature.body).get(FEATURE_NAME_FIELD) ?? '');
  if (feature === undefined || !isValidFeatureName(featureName)) {
    return { reason: `#${issue.number} の機能の親 Issue か、その機能名が見つかりません`, closing };
  }
  const featureDir = featureDirectory(config.stages, feature.number, featureName);
  const reviewedStage = /** @type {import('./config.mjs').ReviewedStage} */ (stage);

  return {
    context: {
      issue,
      stage: reviewedStage,
      feature,
      featureDir,
      artifact: artifactPath(stage, featureDir),
      sharedArtifacts: sharedArtifactPaths(stage),
      documents: reviewDocuments(stage, featureDir),
      allowedFiles: expandStageFiles(config.stages, reviewedStage, featureDir),
    },
  };
}
