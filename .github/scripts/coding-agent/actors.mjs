/**
 * イベントを起こしたアカウントを信頼できるか判定する。
 */

import { findAgentByBot, isCoordinator } from './config.mjs';
import { hasWritePermission } from './github-issues.mjs';

/** Issue や PR ごとに振り分けをやり直すときに、手動実行するアカウント */
export const ACTIONS_BOT = 'github-actions[bot]';

/**
 * イベントを起こしたアカウントを信頼できるか判定する。書き込み権限の無いユーザーの操作で、エージェントを動かさないため。
 * 進行役とエージェントの App (マージによる Close など) と、振り分けをやり直す GitHub Actions は信頼する。
 *
 * @param {import('./route.mjs').HandlerArgs} args
 * @returns {Promise<boolean>}
 */
export async function isTrustedActor({ github, context, config }) {
  const actor = context.actor;
  if (isCoordinator(config.agents, actor) || findAgentByBot(config.agents, actor) !== undefined || actor === ACTIONS_BOT) {
    return true;
  }
  return hasWritePermission(github, context.repo, actor);
}
