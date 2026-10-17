/**
 * 機能の開発の段階の定義。段階の Issue の作成や、段階の Issue の見分けに使う。
 */

/**
 * @typedef {'requirements' | 'specification' | 'domain-model' | 'architecture' | 'project' | 'planning'} FeatureStage
 */

/**
 * @typedef {'architecture' | 'api'} SharedDocumentId
 */

/**
 * @typedef {object} StageDefinition
 * @property {FeatureStage} id 段階の識別子 (ラベルは stage:<id>)
 * @property {string} name 段階の名前
 * @property {string | null} artifact 成果物のファイル名 (機能ごとのディレクトリからの相対パス。文書を作らない段階は null)
 * @property {SharedDocumentId[]} sharedArtifacts あわせて書き足す、機能をまたいで使う文書
 * @property {FeatureStage[]} inputs 担当に渡す、前の段階までの成果物
 * @property {SharedDocumentId[]} sharedInputs 担当に渡す、機能をまたいで使う文書
 * @property {boolean} [acceptanceCriteriaInput] 担当に、受け入れ基準のファイル (仕様の 10.2) も渡すか
 * @property {string} task 担当の作業内容
 */

/** 機能の親 Issue に付けるラベル */
export const FEATURE_LABEL = 'feature';

/** 実装タスクの段階の識別子 */
export const IMPLEMENTATION_STAGE = 'implementation';

/**
 * 機能をまたいで使う文書。機能ごとのディレクトリの外に置き、アーキテクチャ設計で機能を重ねるたびに書き足す
 * @type {Readonly<Record<SharedDocumentId, { name: string, path: string }>>}
 */
export const SHARED_DOCUMENTS = {
  architecture: { name: '全体の構成', path: 'docs/architecture.md' },
  api: { name: 'API の契約', path: 'docs/api/openapi.yaml' },
};

/**
 * 機能の親 Issue の直下に、この順に横並びで作る段階
 * @type {readonly StageDefinition[]}
 */
export const FEATURE_STAGES = [
  {
    id: 'requirements',
    name: '要件定義',
    artifact: 'requirements.md',
    sharedArtifacts: [],
    inputs: [],
    sharedInputs: [],
    task: '機能の親 Issue をもとに、機能要件と非機能要件をまとめた要件定義書を作成してください。',
  },
  {
    id: 'specification',
    name: '仕様書',
    artifact: 'specification.md',
    sharedArtifacts: [],
    inputs: ['requirements'],
    sharedInputs: [],
    task: '要件定義書をもとに、異常系や境界値も含めた振る舞いを定めた仕様書を作成してください。',
  },
  {
    id: 'domain-model',
    name: '概念モデル',
    artifact: 'domain-model.md',
    sharedArtifacts: [],
    inputs: ['specification'],
    sharedInputs: [],
    task: '仕様書をもとに、仕様に出てくる概念と関係を表した概念モデルを作成してください。',
  },
  {
    id: 'architecture',
    name: 'アーキテクチャ設計',
    artifact: 'architecture.md',
    sharedArtifacts: ['architecture', 'api'],
    inputs: ['requirements', 'specification', 'domain-model'],
    sharedInputs: [],
    task: '要件定義書、仕様書、概念モデルをもとに、非機能要件を満たすアーキテクチャを設計してください。あわせて、全体の構成と API の契約を書き足してください。',
  },
  {
    id: 'project',
    name: 'プロジェクトの作成',
    artifact: null,
    sharedArtifacts: [],
    inputs: ['architecture'],
    sharedInputs: ['architecture', 'api'],
    task: 'アーキテクチャ設計と全体の構成をもとに、プロジェクトの土台 (ビルドの設定、テストを実行するスクリプトとコンテナの定義、アーキテクチャのルールなど) を作成し、足りないものを加えてください。',
  },
  {
    id: 'planning',
    name: '実装計画',
    artifact: null,
    sharedArtifacts: [],
    inputs: ['specification', 'domain-model', 'architecture'],
    sharedInputs: ['architecture', 'api'],
    acceptanceCriteriaInput: true,
    task: '仕様書、受け入れ基準、概念モデル、アーキテクチャ設計をもとに、実装タスクの Issue に分割してください。',
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
 * 段階の PR のレビューで、参考資料として渡す前の段階の成果物を返す。
 * 作成の担当に渡す資料と同じにする。実装タスクは、実装計画に渡した資料を参考資料にする。
 *
 * @param {string} stage 段階の識別子
 * @param {string} featureDir 機能ごとのディレクトリ
 * @returns {{ name: string, path: string }[]}
 */
export function reviewDocuments(stage, featureDir) {
  const definition = getFeatureStage(stage === IMPLEMENTATION_STAGE ? 'planning' : stage);
  return [
    ...definition.inputs.map((input) => {
      const source = getFeatureStage(input);
      return { name: source.name, path: `${featureDir}/${source.artifact}` };
    }),
    ...(definition.acceptanceCriteriaInput === true ? [{ name: '受け入れ基準', path: acceptanceCriteriaPath(featureDir) }] : []),
    ...definition.sharedInputs.map((id) => ({ ...SHARED_DOCUMENTS[id] })),
  ];
}

/**
 * 段階の成果物とあわせて書き足す、機能をまたいで使う文書のパスを返す。
 *
 * @param {string} stage 段階の識別子
 * @returns {string[]}
 */
export function sharedArtifactPaths(stage) {
  if (stage === IMPLEMENTATION_STAGE) {
    return [];
  }
  return getFeatureStage(stage).sharedArtifacts.map((id) => SHARED_DOCUMENTS[id].path);
}

/**
 * 段階の成果物のパスを返す。成果物が文書でない段階 (プロジェクトの作成、実装計画、実装タスク) は null を返す。
 *
 * @param {string} stage 段階の識別子
 * @param {string} featureDir 機能ごとのディレクトリ
 * @returns {string | null}
 */
export function artifactPath(stage, featureDir) {
  if (stage === IMPLEMENTATION_STAGE) {
    return null;
  }
  const { artifact } = getFeatureStage(stage);
  return artifact === null ? null : `${featureDir}/${artifact}`;
}

/** 受け入れ基準のファイルの名前 (機能ごとのディレクトリの中。仕様の 10.2) */
export const ACCEPTANCE_CRITERIA_FILE = 'acceptance-criteria.json';

/**
 * 機能ごとのディレクトリから、受け入れ基準のファイルのパスを返す。
 * 受け入れ基準のファイルは、仕様書の段階で、エージェントの出力から仕組みが作る (acceptance-criteria.mjs)
 *
 * @param {string} featureDir 機能ごとのディレクトリ
 * @returns {string}
 */
export function acceptanceCriteriaPath(featureDir) {
  return `${featureDir}/${ACCEPTANCE_CRITERIA_FILE}`;
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
    lines.push('', '## 成果物', '', `- \`${featureDir}/${stage.artifact}\``);
    for (const id of stage.sharedArtifacts) {
      lines.push(`- ${SHARED_DOCUMENTS[id].name}: \`${SHARED_DOCUMENTS[id].path}\``);
    }
  }
  if (stage.inputs.length > 0 || stage.sharedInputs.length > 0) {
    lines.push('', '## 参考資料', '');
    for (const input of stage.inputs) {
      const definition = getFeatureStage(input);
      lines.push(`- ${definition.name}: \`${featureDir}/${definition.artifact}\``);
    }
    for (const id of stage.sharedInputs) {
      lines.push(`- ${SHARED_DOCUMENTS[id].name}: \`${SHARED_DOCUMENTS[id].path}\``);
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
