import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { KNOWLEDGE, KNOWLEDGE_ROOT, STAGE_KNOWLEDGE, knowledgeFor, readKnowledge } from './knowledge.mjs';
import { FEATURE_STAGES, IMPLEMENTATION_STAGE } from './stages.mjs';

describe('段階に渡す知識', () => {
  it('仕様の 6.5 の表のとおりに、段階ごとに知識を割り当てる', () => {
    assert.deepEqual(STAGE_KNOWLEDGE, {
      requirements: ['scope'],
      specification: ['scope', 'acceptance-criteria'],
      architecture: ['scope', 'tech-stacks', 'architecture-documents'],
      project: ['project', 'architecture-rules'],
      implementation: ['implementation', 'acceptance-tests'],
    });
  });

  it('割り当てる段階は、定義された段階に限る', () => {
    const stages = [...FEATURE_STAGES.map((stage) => stage.id), IMPLEMENTATION_STAGE];
    for (const stage of Object.keys(STAGE_KNOWLEDGE)) {
      assert.ok(stages.includes(/** @type {never} */ (stage)), stage);
    }
  });

  it('どの知識も、どこかの段階に渡し、ファイルがある', async () => {
    const used = new Set(Object.values(STAGE_KNOWLEDGE).flat());
    for (const [id, { path }] of Object.entries(KNOWLEDGE)) {
      assert.ok(used.has(/** @type {never} */ (id)), `${id} はどの段階にも渡していません`);
      await access(join(KNOWLEDGE_ROOT, path));
    }
  });

  it('割り当ての無い段階には、知識を渡さない', async () => {
    assert.deepEqual(knowledgeFor('domain-model'), []);
    assert.deepEqual(knowledgeFor('toString'), []);
    assert.deepEqual(await readKnowledge('planning'), []);
  });

  it('段階に割り当てた順に、知識の名前と本文を読み込む', async () => {
    const knowledge = await readKnowledge('architecture');
    assert.deepEqual(
      knowledge.map((item) => item.name),
      ['スコープの決め方', '既定の技術スタック', '全体の構成と API の契約の書き方'],
    );
    assert.ok(knowledge.every((item) => item.body.trim().length > 0));
  });
});
