# 一時的な検証用申込診断

ローカル実装のみ。設定変更・デプロイ・実通信は未実施。

## 有効化条件

すべてサーバー環境で完全一致が必要。リクエストから変更できない。

- REGISTRATION_DIAGNOSTICS_ENABLED=true
- VERCEL=1、NODE_ENV=production
- VERCEL_ENV=production または preview
- VERCEL_GIT_REPO_OWNER=gao-dao
- VERCEL_GIT_REPO_SLUG=shinseikai-hub-preview
- VERCEL_PROJECT_PRODUCTION_URL=shinseikai-hub-preview.vercel.app

システム変数の欠落時も無効。実デプロイで提供されるかは未確認。診断GETは有効・無効とも405、Allow: POST、Cache-Control: no-store、本文なし。無効時はログなし。既存POSTは変更しない。

## 次の承認後の手順

1. previewのGit remoteとVercelプロジェクト、システム変数の提供設定を確認。元リポジトリは操作しない。
2. previewにだけコードを反映し、診断フラグを適用対象の環境に設定して再デプロイする。今回は実施しない。
3. https://shinseikai-hub-preview.vercel.app/api/registrations をGETで一度開く。405は正常。申込POSTを送らない。
4. 検証用FunctionログのREGISTRATION_PREVIEW_DIAGNOSTICSを見る。出力は固定イベント名と真偽値のみ。
5. ログがなければガード変数・フラグ・デプロイ反映を確認する。条件を緩めない。

## 診断範囲

Origin形式と既知の検証Origin許可、IPモード・実行環境条件、x-real-ipの存在と形式、Redis URL・トークン・HMAC・namespace・制限値の形式。Redis通信、Turnstile検証、DB・RPC呼出し、本文読み取りは行わない。値・ハッシュ・長さ・IP・ヘッダー全文・例外原文はログにしない。

GETで確認した現在の状態であり過去POSTの証拠ではない。秘密値の真偽や実接続を保証しない。origin/redisの検証は本番関数を変更しないため専用コードで再現。将来の本体変更時は一致を再確認する。公開GETの連打はログ・Function費用を発生させ得るため短期間だけ有効化する。

## 削除

診断フラグを削除／無効化して検証用へ再反映。その後route.ts末尾の一時GET全体と、lib/security/registration-diagnostics.ts、tests/registration-diagnostics.test.mjs、本手順書だけを削除。既存POST・IP・Redis・Turnstileのコードは変更しない。GETはフレームワーク既定の405に戻る。全テスト・型・Lintを再実行し、承認後に検証用へ反映する。既存ログの保存期間は運用側で確認する。
