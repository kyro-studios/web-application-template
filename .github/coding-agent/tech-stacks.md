# 技術スタック

## 共通

- Docker
- Node.js LTS (npm)
- JDK 21

## フロントエンド

### Language

- TypeScript

### UI

- React
- React Router
- Tailwind CSS
- Radix UI (Primitives)

### ビルドシステム

- Vite

### テスト

- Vitest
- Playwright

### Linting

- Oxc (oxfmt & oxlint)

### デプロイ

- Cloud Run

## バックエンド

### Language

- Java

### Core

- Javalin

### DB

- PostgreSQL (Neon)

### ORM

- jOOQ

### ビルドシステム

- Gradle

### テスト

- JUnit
- Testcontainers
- ArchUnit

### Linting

- Spotless

### デプロイ

- Cloud Run

## 使い方

- アプリケーションのコードは、すべて `app/` の下に置く。`app/` の中の分け方 (フロントエンドとバックエンドの 2 つに分けるか、モジュラーモノリスにするかなど) は、アーキテクチャ設計で決める。小さいうちは 2 つに分け、機能が増えたらモジュールに分けるのを目安にする
- モジュール間の依存の向きは、ArchUnit のテストで確かめる
- React Router の使い方 (SPA として使うか、フレームワークのモードで使うか) は、アーキテクチャ設計で決める
- 単体テストは、フロントエンドは Vitest、バックエンドは JUnit で書く。Playwright は受け入れテスト (`acceptance/`) に使う
- テストで使う PostgreSQL は、Testcontainers で起動する。Neon には接続しない
- ツールのメジャーバージョン (Node.js の LTS、JDK 21) は、`scripts/test.Dockerfile` で固定する
