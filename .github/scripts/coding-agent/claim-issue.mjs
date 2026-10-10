/**
 * Issue に起動済みであることを示すコメントを残し、同じエージェントの二重起動を防ぐ。
 * 同一 Issue に対する判定は concurrency で直列化されている前提で動作する。
 *
 * 環境変数:
 * - AGENT_ID: マーカーに埋め込むエージェントの識別子
 * - AGENT_NAME: コメントに表示するエージェント名
 * - ISSUE_NUMBER: 対象の Issue 番号
 * - FORCE: 'true' なら起動済みでも再実行する
 */

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/**
 * Issue のコメントのうち、マーカーの判定に使う項目
 * @typedef {object} IssueComment
 * @property {{ login: string } | null} user 投稿者 (退会済みユーザーなら null)
 * @property {string} [body] 本文
 */

/** このワークフローが GITHUB_TOKEN で投稿したコメントだけをマーカーとして扱う */
const COMMENT_AUTHOR = 'github-actions[bot]';

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function claimIssue({ github, context, core }) {
  core.setOutput('claimed', 'false');

  const agentId = process.env.AGENT_ID ?? '';
  const agentName = process.env.AGENT_NAME ?? agentId;
  const issueNumber = Number.parseInt(process.env.ISSUE_NUMBER ?? '', 10);
  const marker = `<!-- coding-agent-launch:${agentId} -->`;

  if (process.env.FORCE !== 'true') {
    /** @type {IssueComment[]} */
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...context.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const launched = comments.some(
      (comment) => comment.user?.login === COMMENT_AUTHOR && comment.body?.includes(marker),
    );

    if (launched) {
      core.notice(`${agentName} は Issue #${issueNumber} に対して起動済みのため、スキップします (再実行する場合は force を有効にして手動実行してください)`);
      return;
    }
  }

  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: issueNumber,
    body: [
      marker,
      `🤖 起動条件を満たしたため、${agentName} を起動しました。`,
      '',
      `- ワークフロー: ${runUrl}`,
    ].join('\n'),
  });

  core.setOutput('claimed', 'true');
}
