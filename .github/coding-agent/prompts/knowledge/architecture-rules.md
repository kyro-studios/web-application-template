## 置き場所

- モジュール間の依存のルールは、`architecture-rules/` に置いてください。`app/` の中には置かないでください。実装の担当が、ルールそのものや、ルールを読み込む設定を書き換えられないようにするためです
- TypeScript のルールは、dependency-cruiser で書き、`architecture-rules/dependency-cruiser.cjs` に置いてください。dependency-cruiser は、`architecture-rules/` の `package.json` で入れてください
- Java のルールは、ArchUnit で書き、`architecture-rules/archunit/` に、ルールとそれを動かす独立した Gradle のプロジェクトを置いてください

## 書き方

- 全体の構成 (`docs/architecture.md`) に書かれたモジュール間の依存の向きを、そのままルールに書き起こしてください。全体の構成に無いルールを足さないでください
- 依存の循環を禁止するルールも入れてください
- その言語のコードがまだ無い場合は、その言語のルールは作らないでください

## 実行のしかた

- `scripts/test.sh` から、`app/` の中の設定 (`package.json` の scripts や Gradle の設定) を通さずに、直接実行してください
  - dependency-cruiser: `--config architecture-rules/dependency-cruiser.cjs` で設定を指定して、検査するディレクトリを渡す
  - ArchUnit: `app/` のビルドが出力したクラスファイルのディレクトリを、`architecture-rules/archunit/` の Gradle のプロジェクトから、パスを指定して読み込んで検査する
- ルールに違反したら、`scripts/test.sh` が失敗するようにしてください
