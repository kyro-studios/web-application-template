/**
 * 機能の開発の段階の定義。段階の Issue の作成や、段階の Issue の見分けに使う。
 */

/**
 * @typedef {'requirements' | 'specification' | 'domain-model' | 'architecture' | 'planning'} FeatureStage
 */

/**
 * @typedef {object} StageDefinition
 * @property {FeatureStage} id 段階の識別子 (ラベルは stage:<id>)
 * @property {string} name 段階の名前
 * @property {string | null} artifact 成果物のファイル名 (機能ごとのディレクトリからの相対パス。実装計画は Issue を作るため null)
 * @property {FeatureStage[]} inputs 担当に渡す、前の段階までの成果物
 * @property {string} task 担当の作業内容
 */

/** 機能の親 Issue に付けるラベル */
export const FEATURE_LABEL = 'feature';

/** 実装タスクの段階の識別子 */
export const IMPLEMENTATION_STAGE = 'implementation';

/**
 * 機能の親 Issue の直下に、この順に横並びで作る段階
 * @type {readonly StageDefinition[]}
 */
export const FEATURE_STAGES = [
  {
    id: 'requirements',
    name: '要件定義',
    artifact: 'requirements.md',
    inputs: [],
    task: '機能の親 Issue をもとに、機能要件と非機能要件をまとめた要件定義書を作成してください。',
  },
  {
    id: 'specification',
    name: '仕様書',
    artifact: 'specification.md',
    inputs: ['requirements'],
    task: '要件定義書をもとに、異常系や境界値も含めた振る舞いを定めた仕様書を作成してください。',
  },
  {
    id: 'domain-model',
    name: '概念モデル',
    artifact: 'domain-model.md',
    inputs: ['specification'],
    task: '仕様書をもとに、仕様に出てくる概念と関係を表した概念モデルを作成してください。',
  },
  {
    id: 'architecture',
    name: 'アーキテクチャ設計',
    artifact: 'architecture.md',
    inputs: ['requirements', 'specification', 'domain-model'],
    task: '要件定義書、仕様書、概念モデルをもとに、非機能要件を満たすアーキテクチャを設計してください。',
  },
  {
    id: 'planning',
    name: '実装計画',
    artifact: null,
    inputs: ['specification', 'domain-model', 'architecture'],
    task: '仕様書、概念モデル、アーキテクチャ設計をもとに、実装タスクの Issue に分割してください。',
  },
];

/**
 * 段階のラベルを返す。
 *
 * @param {string} stage 段階の識別子
 * @returns {string}
 */
export function stageLabel(stage) {
  return `stage:${stage}`;
}

/**
 * ラベルの一覧から、段階の識別子を取り出す。段階のラベルが無いか、複数ある場合は undefined を返す。
 *
 * @param {readonly (string | { name?: string })[]} labels
 * @returns {string | undefined}
 */
export function stageOf(labels) {
  const stages = labels
    .map((label) => (typeof label === 'string' ? label : label.name ?? ''))
    .filter((name) => name.startsWith('stage:'))
    .map((name) => name.slice('stage:'.length));
  return stages.length === 1 ? stages[0] : undefined;
}

/**
 * 段階の定義を返す。
 *
 * @param {string} stage 段階の識別子
 * @returns {StageDefinition}
 * @throws {Error} 機能の親 Issue の直下に作る段階でない場合
 */
export function getFeatureStage(stage) {
  const definition = FEATURE_STAGES.find((candidate) => candidate.id === stage);
  if (definition === undefined) {
    throw new Error(`段階 "${stage}" は定義されていません`);
  }
  return definition;
}

/**
 * 段階の Issue の本文を作る。
 *
 * @param {object} args
 * @param {StageDefinition} args.stage 段階
 * @param {number} args.featureIssueNumber 機能の親 Issue の番号
 * @param {string} args.featureDir 機能ごとのディレクトリ
 * @returns {string}
 */
export function stageIssueBody({ stage, featureIssueNumber, featureDir }) {
  const lines = [`#${featureIssueNumber} の「${stage.name}」の段階です。`, '', '## 作業内容', '', stage.task];

  if (stage.artifact !== null) {
    lines.push('', '## 成果物', '', `\`${featureDir}/${stage.artifact}\``);
  }
  if (stage.inputs.length > 0) {
    lines.push('', '## 参考資料', '');
    for (const input of stage.inputs) {
      const definition = getFeatureStage(input);
      lines.push(`- ${definition.name}: \`${featureDir}/${definition.artifact}\``);
    }
  }
  if (stage.id === 'requirements') {
    lines.push(
      '',
      '## 進め方',
      '',
      `- 要件定義書を書いたら、この Issue を Close する PR (本文に \`Closes #<この Issue の番号>\`) を作成してください`,
      '- 書いている途中は Draft の PR にしておき、書き終えたら Ready for review にしてください。Draft の PR はレビューされません',
      '- レビュー担当が承認すると自動でマージされ、次の段階に進みます',
    );
  }
  return `${lines.join('\n')}\n`;
}
