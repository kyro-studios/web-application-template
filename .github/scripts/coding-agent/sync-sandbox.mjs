/**
 * テンプレートの変更を、動作確認用のリポジトリの develop に取り込む。テンプレートで仕組みを開発する人が使う。
 *
 * テンプレートから作ったリポジトリは、テンプレートの後の変更を自動では受け取らない。また、Issue のイベントで
 * 動くワークフローは既定ブランチ (develop) のものが使われるため、動作確認の前に develop へ反映する必要がある。
 * develop はルールセットで保護されているため、取り込みを push する間だけルールセットを無効にし、必ず有効に戻す。
 * 取り込むのは、仕組みのファイル (mechanism-files.mjs) だけ。その範囲の中はテンプレートと同じにし (テンプレートで
 * 削除したファイルも削除する)、範囲の外 (エージェントが作ったアプリケーションのコードや成果物) には触れない。
 * テンプレートのファイルのうち、どちらにも分類されていないものがあれば、何もせずに終わる。--agents を指定すると、
 * 手元のファイルで agents.json を置き換える。push する前に、取り込んだ後の設定ファイルを検証する。
 *
 * 確認用のリポジトリの管理者が、gh コマンドにログインした状態で実行する。
 *
 * 使い方:
 *   node .github/scripts/coding-agent/sync-sandbox.mjs --template <owner>/<name> --sandbox <owner>/<name> [--ref <ブランチ>] [--agents <ファイル>]
 *
 * オプション:
 *   --template  取り込み元のテンプレートのリポジトリ
 *   --sandbox   取り込み先の確認用のリポジトリ
 *   --ref       取り込むテンプレートのブランチ (既定は main)
 *   --agents    確認用のリポジトリの agents.json にする手元のファイル (省略すると確認用のリポジトリの内容を残す)
 */

import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { minimatch } from 'minimatch';
import { CONFIG_DIR, loadConfig } from './config.mjs';
import { MECHANISM_FILE_PATTERNS } from './mechanism-files.mjs';
import { DEVELOP_BRANCH, RULESET_NAMES } from './setup-repository.mjs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * テンプレートから取り込むファイル。仕組みのファイル (mechanism-files.mjs) と同じにする。仕組みのファイルの範囲の外を
 * PR を通さずに変えると、確認用のリポジトリの仕組みが止まるため (PR を通らない変更の検知)
 */
export const SYNCED_PATTERNS = MECHANISM_FILE_PATTERNS;

/**
 * テンプレートにあるが、取り込まないファイル。確認用のリポジトリに固有の設定 (agents.json) と、
 * テンプレートから作ったリポジトリ (エージェントを含む) が書き換えるファイル。SYNCED_PATTERNS より優先する
 */
export const NOT_SYNCED_PATTERNS = [`${CONFIG_DIR}/agents.json`, '.gitignore', 'README.md', 'AGENTS.md', '.vscode/**'];

/**
 * @param {string} path リポジトリのルートからのパス
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesAny(path, patterns) {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

/**
 * ファイルを取り込むかどうかを返す。どちらにも分類されていなければ undefined を返す。
 *
 * @param {string} path リポジトリのルートからのパス
 * @returns {'synced' | 'not-synced' | undefined}
 */
export function classifyPath(path) {
  if (matchesAny(path, NOT_SYNCED_PATTERNS)) {
    return 'not-synced';
  }
  return matchesAny(path, SYNCED_PATTERNS) ? 'synced' : undefined;
}

/**
 * @typedef {object} SyncPlan
 * @property {string[]} checkout テンプレートの内容にするファイル (追加と変更)
 * @property {string[]} remove テンプレートで削除されたため、確認用のリポジトリからも削除するファイル
 * @property {string[]} unclassified テンプレートのファイルのうち、どちらにも分類されていないもの
 */

/**
 * 取り込みで追加、変更、削除するファイルを決める。取り込む範囲の外のファイルは、どちらにも含めない。
 *
 * @param {string[]} templateFiles テンプレートのファイル
 * @param {string[]} sandboxFiles 確認用のリポジトリのファイル
 * @returns {SyncPlan}
 */
export function planSync(templateFiles, sandboxFiles) {
  const inTemplate = new Set(templateFiles);
  return {
    checkout: templateFiles.filter((path) => classifyPath(path) === 'synced'),
    remove: sandboxFiles.filter((path) => classifyPath(path) === 'synced' && !inTemplate.has(path)),
    unclassified: templateFiles.filter((path) => classifyPath(path) === undefined),
  };
}

/**
 * @typedef {object} SyncOptions
 * @property {string} template 取り込み元のテンプレートのリポジトリ (<owner>/<name>)
 * @property {string} sandbox 取り込み先の確認用のリポジトリ (<owner>/<name>)
 * @property {string} ref 取り込むテンプレートのブランチ
 * @property {string | undefined} agents 確認用のリポジトリの agents.json にする手元のファイル
 */

/**
 * コマンドライン引数を解釈する。
 *
 * @param {string[]} args
 * @returns {SyncOptions}
 * @throws {Error} 引数が正しくない場合
 */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      template: { type: 'string' },
      sandbox: { type: 'string' },
      ref: { type: 'string', default: 'main' },
      agents: { type: 'string' },
    },
    strict: true,
  });

  for (const name of /** @type {const} */ (['template', 'sandbox'])) {
    if (!REPOSITORY_PATTERN.test(values[name] ?? '')) {
      throw new Error(`--${name} には <owner>/<name> の形式でリポジトリを指定してください`);
    }
  }
  const template = /** @type {string} */ (values.template);
  const sandbox = /** @type {string} */ (values.sandbox);
  if (template.toLowerCase() === sandbox.toLowerCase()) {
    throw new Error('--template と --sandbox には別のリポジトリを指定してください');
  }
  const ref = values.ref ?? 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-')) {
    throw new Error(`--ref のブランチ名が正しくありません: ${ref}`);
  }

  return { template, sandbox, ref, agents: values.agents === undefined ? undefined : resolve(values.agents) };
}

/**
 * 取り込みのコミットメッセージを作る。
 *
 * @param {string} template 取り込み元のテンプレートのリポジトリ
 * @param {string} sha 取り込むテンプレートのコミット
 * @returns {string}
 */
export function syncCommitMessage(template, sha) {
  return `chore: sync with template\n\nBring in ${template}@${sha}.\n`;
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string }} [options]
 * @returns {string}
 */
function git(args, options = {}) {
  return execFileSync('git', args, { cwd: options.cwd, input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {any}
 */
function ghApi(method, path, body) {
  const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path];
  if (body !== undefined) {
    args.push('--input', '-');
  }
  const output = execFileSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return output.trim() === '' ? null : JSON.parse(output);
}

/**
 * コミットに含まれるファイルのパスを返す。
 *
 * @param {string} commit
 * @param {string} cwd
 * @returns {string[]}
 */
function filesOf(commit, cwd) {
  return git(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', commit], { cwd })
    .split('\n')
    .filter((path) => path !== '');
}

/**
 * @param {SyncOptions} options
 */
async function sync(options) {
  const workDir = await mkdtemp(join(tmpdir(), 'coding-agent-sync-'));
  try {
    const cwd = join(workDir, 'sandbox');
    git(['clone', '--quiet', '--branch', DEVELOP_BRANCH, `https://github.com/${options.sandbox}.git`, cwd]);
    git(['fetch', '--quiet', `https://github.com/${options.template}.git`, options.ref], { cwd });
    const sha = git(['rev-parse', 'FETCH_HEAD'], { cwd });

    // 取り込む範囲の中だけ、テンプレートと同じにする (テンプレートで削除したファイルも削除する)
    const plan = planSync(filesOf('FETCH_HEAD', cwd), filesOf('HEAD', cwd));
    if (plan.unclassified.length > 0) {
      throw new Error(
        `テンプレートに、取り込むかどうかが決まっていないファイルがあります。mechanism-files.mjs の MECHANISM_FILE_PATTERNS か、sync-sandbox.mjs の NOT_SYNCED_PATTERNS に加えてください:\n${plan.unclassified.map((path) => `  ${path}`).join('\n')}`,
      );
    }
    // パスに glob の記号が含まれても、そのままのパスとして扱う
    if (plan.remove.length > 0) {
      git(['--literal-pathspecs', 'rm', '--quiet', '--pathspec-from-file=-'], { cwd, input: plan.remove.join('\n') });
    }
    git(['--literal-pathspecs', 'checkout', 'FETCH_HEAD', '--pathspec-from-file=-'], { cwd, input: plan.checkout.join('\n') });
    if (options.agents !== undefined) {
      await copyFile(options.agents, join(cwd, CONFIG_DIR, 'agents.json'));
      git(['add', '--', `${CONFIG_DIR}/agents.json`], { cwd });
    }
    // テンプレートで設定の形式が変わっていても気づけるよう、取り込んだ後の設定を検証する (問題があれば ConfigError)
    await loadConfig(cwd);
    if (git(['diff', '--cached', '--name-only'], { cwd }) === '') {
      console.log(`${options.sandbox} の ${DEVELOP_BRANCH} は、${options.template}@${sha.slice(0, 7)} と同じ内容です (固有の設定を除く)`);
      return;
    }
    git(['commit', '--quiet', '--no-verify', '--file', '-'], { cwd, input: syncCommitMessage(options.template, sha) });

    const base = `repos/${options.sandbox}`;
    const ruleset = ghApi('GET', `${base}/rulesets?includes_parents=false&per_page=100`).find(
      (/** @type {{ name: string }} */ candidate) => candidate.name === RULESET_NAMES.develop,
    );
    if (ruleset === undefined) {
      throw new Error(`${options.sandbox} に ${RULESET_NAMES.develop} のルールセットがありません。先にセットアップのスクリプトを実行してください`);
    }

    ghApi('PUT', `${base}/rulesets/${ruleset.id}`, { enforcement: 'disabled' });
    console.log(`✔ ${RULESET_NAMES.develop} のルールセットを一時的に無効にしました`);
    try {
      git(['push', '--quiet', 'origin', DEVELOP_BRANCH], { cwd });
      console.log(`✔ ${options.template}@${sha.slice(0, 7)} の内容を ${options.sandbox} の ${DEVELOP_BRANCH} に push しました`);
    } finally {
      ghApi('PUT', `${base}/rulesets/${ruleset.id}`, { enforcement: 'active' });
      console.log(`✔ ${RULESET_NAMES.develop} のルールセットを有効に戻しました`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await sync(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
