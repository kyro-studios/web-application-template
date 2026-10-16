import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL_PREFIX, AUTHORED_STAGES, loadConfig } from './config.mjs';
import { LABELS } from './setup-repository.mjs';
import { FEATURE_LABEL, FEATURE_STAGES, IMPLEMENTATION_STAGE, getFeatureStage, stageIssueBody, stageLabel, stageOf } from './stages.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));

describe('段階の定義', () => {
  it('設定ファイルやセットアップのラベルと、段階がそろっている', async () => {
    const config = await loadConfig(ROOT_DIR);
    const authored = FEATURE_STAGES.filter((stage) => stage.id !== 'requirements').map((stage) => stage.id);
    assert.deepEqual([...AUTHORED_STAGES].sort(), [...authored].sort());
    assert.deepEqual(Object.keys(config.agents.roles).sort(), [...FEATURE_STAGES.map((stage) => stage.id), IMPLEMENTATION_STAGE].sort());

    // PR を作る段階 (実装計画のほか) は、変更してよいファイルを決める
    const reviewed = FEATURE_STAGES.filter((stage) => stage.id !== 'planning').map((stage) => stage.id);
    assert.deepEqual(Object.keys(config.stages.stages).sort(), [...reviewed, IMPLEMENTATION_STAGE].sort());

    const labels = LABELS.map((label) => label.name);
    for (const stage of [...FEATURE_STAGES.map((definition) => definition.id), IMPLEMENTATION_STAGE]) {
      assert.ok(labels.includes(stageLabel(stage)), stage);
    }
    assert.ok(labels.includes(FEATURE_LABEL));
  });

  it('担当に渡す資料は、前の段階の成果物だけにする', () => {
    for (const [index, stage] of FEATURE_STAGES.entries()) {
      const previous = FEATURE_STAGES.slice(0, index);
      for (const input of stage.inputs) {
        assert.ok(previous.some((candidate) => candidate.id === input && candidate.artifact !== null), `${stage.id} の ${input}`);
      }
    }
  });
});

describe('振り分け用のワークフローの起動の条件', () => {
  it('機能の親 Issue のラベルで、Issue の作成と編集のときに起動するかを決める', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile(new URL('../../workflows/coding-agent-router.yml', import.meta.url), 'utf8');
    assert.ok(workflow.includes(`contains(github.event.issue.labels.*.name, '${FEATURE_LABEL}')`));
  });

  it('担当のエージェントのラベルが付いたときに起動する', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile(new URL('../../workflows/coding-agent-router.yml', import.meta.url), 'utf8');
    assert.ok(workflow.includes(`startsWith(github.event.label.name, '${AGENT_LABEL_PREFIX}')`));
  });
});

describe('stageOf', () => {
  it('段階のラベルがちょうど 1 つなら、段階を返す', () => {
    assert.equal(stageOf([{ name: 'bug' }, { name: 'stage:planning' }]), 'planning');
    assert.equal(stageOf(['stage:requirements']), 'requirements');
    assert.equal(stageOf([{ name: 'feature' }]), undefined);
    assert.equal(stageOf(['stage:requirements', 'stage:planning']), undefined);
  });
});

describe('stageIssueBody', () => {
  it('作業内容、成果物、参考資料を書く', () => {
    const body = stageIssueBody({ stage: getFeatureStage('architecture'), featureIssueNumber: 12, featureDir: 'docs/features/12-login' });
    assert.match(body, /^#12 の「アーキテクチャ設計」の段階です。/);
    assert.match(body, /## 成果物\n\n- `docs\/features\/12-login\/architecture\.md`\n- 全体の構成: `docs\/architecture\.md`\n- API の契約: `docs\/api\/openapi\.yaml`/);
    assert.match(body, /- 概念モデル: `docs\/features\/12-login\/domain-model\.md`/);
    assert.doesNotMatch(body, /## 進め方/);
  });

  it('プロジェクトの作成には、成果物の文書を書かず、全体の構成と API の契約を参考資料に書く', () => {
    const body = stageIssueBody({ stage: getFeatureStage('project'), featureIssueNumber: 12, featureDir: 'docs/features/12-login' });
    assert.doesNotMatch(body, /## 成果物/);
    assert.match(body, /## 参考資料\n\n- アーキテクチャ設計: `docs\/features\/12-login\/architecture\.md`\n- 全体の構成: `docs\/architecture\.md`\n- API の契約: `docs\/api\/openapi\.yaml`/);
  });

  it('要件定義には、人が PR を作る進め方を書く', () => {
    const body = stageIssueBody({ stage: getFeatureStage('requirements'), featureIssueNumber: 12, featureDir: 'docs/features/12-login' });
    assert.match(body, /## 進め方/);
    assert.doesNotMatch(body, /## 参考資料/);
  });

  it('実装計画には、成果物のファイルを書かない', () => {
    const body = stageIssueBody({ stage: getFeatureStage('planning'), featureIssueNumber: 12, featureDir: 'docs/features/12-login' });
    assert.doesNotMatch(body, /## 成果物/);
  });
});
