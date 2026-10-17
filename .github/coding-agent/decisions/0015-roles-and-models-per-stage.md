# 0015. 段階ごとに担当とモデルを分けて、費用を抑える

- 日付: 2026-10-12
- 状態: 採用

## 背景

確認用のリポジトリの 1 機能 (タスク 17 件) を、すべて Claude Opus 5.5 で動かすと、Claude だけで 1 機能あたり約 $30〜35 かかる見込みだった。運用の費用を下げる必要があった。

## 決めたこと

- 段階ごとに、作成担当とレビュー担当、使うモデルと effort を、次のように分ける。作成担当とレビュー担当は、段階ごとに別のエージェントにする (仕様の 2.3)

| 段階 | 作成 | レビュー |
| --- | --- | --- |
| 要件定義 | 人 | Codex 6.1 Sol (Medium) |
| 仕様書 | Claude Haiku 5.5 (High) | Codex 6.1 Sol (Medium) |
| 概念モデル | Codex 6.1 Sol (High) | Claude Haiku 5.5 (Medium) |
| アーキテクチャ設計 | Claude Sonnet 5.5 (Medium) | Codex 6.1 Sol (Medium) |
| プロジェクトの作成 | Claude Sonnet 5.5 (Medium) | Codex 6.1 Sol (Medium) |
| 実装計画 | Claude Sonnet 5.5 (Medium) | なし |
| 実装タスク | Claude Haiku 5.5 (High) | Codex 6.1 Sol (Medium) |

- 修正は、PR を作ったエージェントが、作成より安い設定で行う。Codex は Codex 6 Luna (Low)、Claude は Claude Haiku 5.5 (Low)
- モデルと effort は頻繁に調整するため、設定ファイル (`agents.json`) の書き換えだけで変えられるようにする。ワークフローには、モデルの名前や effort を書かない (仕様の 2.1、2.2)
- テンプレートの `agents.json` には、上の表の値を入れる。Codex 6.1 Sol は `gpt-6.1-sol`、Codex 6 Luna は `gpt-6-luna`
- エージェントごとのワークフローが、作成、修正、レビューのどれも受け持つ。レビューの投稿は、共通のワークフロー (`coding-agent-publish-review.yml`) に切り出す (仕様の 8.3)
- プロジェクトの作成 (2026-10-16 に段階を加えた) は、コマンドの実行を伴うため、Codex にはまだ任せられない (仕様の 6.1)。Claude が作成する
- どの段階を Copilot に割り振るかは、Copilot 用のワークフローを作るとき (仕様の 15.2 の 18) に決める。Copilot Student では、モデルは `auto` だけになる (仕様の 2.5)

## 検討した案

| 案 | 採らなかった理由 |
| --- | --- |
| すべての段階を Claude Opus 5.5 で動かす | 1 機能あたりの費用が大きすぎる |

## 影響

- この構成で 1 機能 (タスク 11 件) を最後まで通したところ、Claude が約 $3.5、OpenAI が約 $2.5 だった
