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
- dependency-cruiser

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

- PostgreSQL

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

- アプリケーションのコードは、すべて `app/` の下に置く。`app/` の中の分け方はアーキテクチャ設計で決める。
- テストで使う PostgreSQL は、Testcontainers で起動する。
- ツールのメジャーバージョン (Node.js の LTS、JDK 21) は、`scripts/test.Dockerfile` で固定する
