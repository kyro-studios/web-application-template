/**
 * 仕組みの停止。既定ブランチが PR を通らずに変わったときなど、そのまま続けると壊れた状態の上に作業を
 * 積み重ねてしまう場合に、進行役の App が「停止中の Issue」を作り、振り分けを止める。
 *
 * 停止中の Issue は、進行役の App が作った、halted ラベルの付いた Open の Issue。人が原因を確かめて直し、
 * Close すると再開する。停止中に処理しなかったイベントは、停止中の Issue にコメントで残す。
 */

import { isCoordinator } from './config.mjs';
import { ensureLabel } from './github-issues.mjs';

/**
 * @typedef {import('./github-issues.mjs').GitHub} GitHub
 * @typedef {import('./github-issues.mjs').Repository} Repository
 * @typedef {import('./config.mjs').CodingAgentConfig} CodingAgentConfig
 */

/** 停止中の Issue に付けるラベル */
export const HALTED_LABEL = 'halted';

/** 停止中の Issue に付けるラベルの定義 */
const HALTED_LABEL_DEFINITION = { name: HALTED_LABEL, color: 'b60205', description: 'Coding Agent の停止中。原因を直して Close すると再開する' };

/**
 * 停止中の Issue を探す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {CodingAgentConfig} config
 * @returns {Promise<{ number: number } | undefined>}
 */
export async function findHaltIssue(github, repository, config) {
  // 停止中の Issue は 1 つしか作らないため、1 ページで足りる
  const { data } = await github.rest.issues.listForRepo({ ...repository, labels: HALTED_LABEL, state: 'open', per_page: 100 });
  return /** @type {{ number: number, user: { login: string } | null, pull_request?: object }[]} */ (data).find(
    (issue) => issue.pull_request === undefined && isCoordinator(config.agents, issue.user?.login),
  );
}

/**
 * 仕組みを止める。停止中の Issue が無ければ作り、あれば理由をコメントで足す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {CodingAgentConfig} config
 * @param {{ title: string, reason: string }} halt 停止中の Issue のタイトルと、止めた理由 (Markdown)
 * @returns {Promise<number>} 停止中の Issue の番号
 */
export async function haltCodingAgent(github, repository, config, { title, reason }) {
  const existing = await findHaltIssue(github, repository, config);
  if (existing !== undefined) {
    await github.rest.issues.createComment({ ...repository, issue_number: existing.number, body: `🤖 ${reason}` });
    return existing.number;
  }
  await ensureLabel(github, repository, HALTED_LABEL_DEFINITION);
  const { data } = await github.rest.issues.create({
    ...repository,
    title,
    body: [
      `🤖 ${reason}`,
      '',
      '## 停止中の動き',
      '',
      '- この Issue が Open の間は、段階の起動、レビュー、修正の依頼などを行いません。処理しなかったイベントは、この Issue にコメントで残します',
      '- 止めた時点で動いていたエージェントのジョブは、最後まで動きます',
      '',
      '## 再開の手順',
      '',
      '1. 上の変更を確かめ、必要なら既定ブランチを直す (消えたファイルを PR で戻すなど)',
      '2. この Issue を Close する',
      '3. この Issue のコメントに残った、処理しなかったイベントをやり直す。Issue や PR の番号を指定して、振り分け用のワークフローを手動実行する',
      '',
      '```bash',
      'gh workflow run coding-agent-router.yml -f issue-number=<番号>',
      '```',
    ].join('\n'),
    labels: [HALTED_LABEL],
  });
  return data.number;
}
