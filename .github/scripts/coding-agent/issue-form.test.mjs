import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { FEATURE_NAME_FIELD, OVERVIEW_FIELD, parseIssueForm } from './issue-form.mjs';

describe('parseIssueForm', () => {
  it('入力欄のラベルの見出しごとに、値を取り出す', () => {
    const fields = parseIssueForm('### 機能名\r\n\r\nuser-login\r\n\r\n### 概要\r\n\r\n1 行目\r\n\r\n2 行目\r\n');
    assert.equal(fields.get('機能名'), 'user-login');
    assert.equal(fields.get('概要'), '1 行目\n\n2 行目');
  });

  it('空の入力欄や、同じラベルの 2 つ目以降の見出しは使わない', () => {
    const fields = parseIssueForm('### 機能名\n\n_No response_\n\n### 機能名\n\nanother');
    assert.equal(fields.get('機能名'), '');
  });

  it('本文が無ければ、何も取り出さない', () => {
    assert.equal(parseIssueForm(null).size, 0);
  });
});

describe('「新規機能」の Issue フォーム', () => {
  it('スクリプトが読み取る入力欄のラベルと、feature ラベルを持つ', async () => {
    const form = await readFile(new URL('../../ISSUE_TEMPLATE/feature.yml', import.meta.url), 'utf8');
    assert.match(form, /^labels: \[feature\]$/m);
    assert.match(form, new RegExp(`^      label: ${FEATURE_NAME_FIELD}$`, 'm'));
    assert.match(form, new RegExp(`^      label: ${OVERVIEW_FIELD}$`, 'm'));
  });
});
