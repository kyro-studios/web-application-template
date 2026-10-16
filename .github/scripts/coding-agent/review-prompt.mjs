/**
 * レビューの依頼から、レビュー担当に渡す指示 (プロンプト) を組み立てる。
 *
 * 指示の本文は、既定ブランチの .github/coding-agent/prompts/review/ から読む (PR の変更で書き換えられないようにする)。
 * 変更してよい範囲の外にあるファイルが変更されていれば、レビュー担当を呼ばずに差し戻すレビューの結果を作る。
 *
 * 使い方 (レビュー担当のワークフローから実行する):
 *   node review-prompt.mjs --request <依頼の JSON> --prompts <指示のディレクトリ> --prompt-out <指示の出力先> --review-out <差し戻しの結果の出力先>
 *
 * GITHUB_OUTPUT に、skip-review (範囲外のファイルがあり、レビュー担当を呼ばないなら 'true') を出力する。
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readKnowledge } from './knowledge.mjs';
import { fence, knowledgeLines, stageName } from './prompt-format.mjs';

/**
 * レビューの依頼の資料 (handlers/request-review.mjs が作る)
 * @typedef {object} ReviewMaterials
 * @property {{ number: number, title: string, body: string, author: string, baseSha: string, headSha: string }} pullRequest
 * @property {{ number: number, title: string, body: string }} issue
 * @property {{ number: number, title: string, body: string }} feature
 * @property {string} featureDir
 * @property {string | null} artifact
 * @property {string[]} [sharedArtifacts]
 * @property {{ name: string, path: string }[]} documents
 * @property {{ allow: string[], deny: string[] }} allowedFiles
 * @property {string[]} violations
 * @property {import('./github-pulls.mjs').PastReview[]} previousReviews
 */

/**
 * レビューの結果 (review-schema.json の形式)
 * @typedef {object} ReviewResult
 * @property {string} summary
 * @property {{ severity: 'must' | 'should' | 'nit', path: string | null, line: number | null, body: string }[]} findings
 */

/**
 * レビュー担当に渡す指示を組み立てる。
 *
 * @param {object} args
 * @param {import('./agent-request.mjs').AgentRequest & { materials: ReviewMaterials }} args.request
 * @param {string} args.common すべての段階に共通する指示
 * @param {string} args.stagePrompt 段階ごとの観点
 * @param {{ name: string, body: string }[]} [args.knowledge] 段階に渡す知識 (作成担当と同じもの)
 * @returns {string}
 */
export function buildReviewPrompt({ request, common, stagePrompt, knowledge = [] }) {
  const { pullRequest, issue, feature, artifact, sharedArtifacts = [], documents, previousReviews } = request.materials;
  const lines = [
    common.trim(),
    '',
    stagePrompt.trim(),
    '',
    ...knowledgeLines(knowledge),
    '## 依頼の内容',
    '',
    `- 段階: ${stageName(request.stage)}`,
    `- PR: #${pullRequest.number} ${pullRequest.title} (作成者: ${pullRequest.author})`,
    `- PR の差分: \`git diff ${pullRequest.baseSha}...HEAD\` で確かめられます`,
    `- Close する Issue: #${issue.number} ${issue.title}`,
    `- 機能の親 Issue: #${feature.number} ${feature.title}`,
  ];
  if (artifact !== null) {
    lines.push(`- 成果物: \`${artifact}\``);
  }
  for (const path of sharedArtifacts) {
    lines.push(`- あわせて書き足す文書: \`${path}\``);
  }
  if (documents.length > 0) {
    lines.push('- 参考資料 (前の段階の成果物):');
    for (const document of documents) {
      lines.push(`  - ${document.name}: \`${document.path}\``);
    }
  }

  lines.push('', '### PR の本文', '', fence(pullRequest.body), '', '### Close する Issue の本文', '', fence(issue.body));
  lines.push('', '### 機能の親 Issue の本文', '', fence(feature.body));

  if (previousReviews.length > 0) {
    lines.push('', '## これまでのレビュー', '', '古いものから順に並べています。');
    for (const review of previousReviews) {
      lines.push('', `### ${review.submittedAt} (${review.state}、コミット ${review.commitId.slice(0, 7)})`, '', fence(review.body));
      for (const comment of review.comments) {
        lines.push('', `- \`${comment.path}\`${comment.line === null ? '' : ` の ${comment.line} 行目`}:`, '', fence(comment.body));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 変更してよい範囲の外にあるファイルがあるときの、差し戻しのレビューの結果を作る。
 *
 * @param {object} args
 * @param {string} args.stage
 * @param {string[]} args.violations 範囲外のファイル
 * @param {{ allow: string[], deny: string[] }} args.allowedFiles 変更してよいファイルと、変更してはいけないファイル
 * @returns {ReviewResult}
 */
export function violationReview({ stage, violations, allowedFiles }) {
  const range = [
    `変更してよいファイル: ${allowedFiles.allow.map((pattern) => `\`${pattern}\``).join('、')}`,
    ...(allowedFiles.deny.length > 0 ? [`変更してはいけないファイル: ${allowedFiles.deny.map((pattern) => `\`${pattern}\``).join('、')}`] : []),
  ].join('\n');
  return {
    summary: `「${stageName(stage)}」の PR で変更できないファイルが変更されているため、内容のレビューを行わずに差し戻します。範囲外の変更を取り除いてください。\n\n${range}`,
    findings: violations.map((path) => ({
      severity: 'must',
      path,
      line: null,
      body: `このファイルは、「${stageName(stage)}」の PR では変更できません。`,
    })),
  };
}

/**
 * @param {string[]} args
 */
async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      request: { type: 'string' },
      prompts: { type: 'string' },
      'prompt-out': { type: 'string' },
      'review-out': { type: 'string' },
    },
    strict: true,
  });
  for (const name of /** @type {const} */ (['request', 'prompts', 'prompt-out', 'review-out'])) {
    if (values[name] === undefined) {
      throw new Error(`--${name} を指定してください`);
    }
  }

  const request = JSON.parse(await readFile(/** @type {string} */ (values.request), 'utf8'));
  if (request.mode !== 'review') {
    throw new Error(`レビューの依頼ではありません: ${request.mode}`);
  }

  /** @type {ReviewMaterials} */
  const materials = request.materials;
  const skip = materials.violations.length > 0;
  if (skip) {
    const review = violationReview({ stage: request.stage, violations: materials.violations, allowedFiles: materials.allowedFiles });
    await writeFile(/** @type {string} */ (values['review-out']), `${JSON.stringify(review, null, 2)}\n`);
  } else {
    const promptsDir = /** @type {string} */ (values.prompts);
    const [common, stagePrompt] = await Promise.all([
      readFile(join(promptsDir, 'common.md'), 'utf8'),
      readFile(join(promptsDir, `${request.stage}.md`), 'utf8'),
    ]);
    const knowledge = await readKnowledge(request.stage);
    await writeFile(/** @type {string} */ (values['prompt-out']), buildReviewPrompt({ request, common, stagePrompt, knowledge }));
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `skip-review=${skip}\n`);
  }
  console.log(skip ? `範囲外のファイルがあるため、レビュー担当を呼ばずに差し戻します: ${materials.violations.join(', ')}` : 'レビューの指示を作成しました');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
