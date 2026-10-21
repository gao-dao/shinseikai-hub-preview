# 一時的な検証用申込診断（二段階）

ローカル実装・モックテストのみ。実Project IDはコード／ログ／本書に記載しない。

## 第1段階：Project IDの照合

Vercel提供のVERCEL_PROJECT_IDと、独自サーバー変数REGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_IDの両方が空白だけでない非空文字列で、完全一致することが必須。期待値には検証用VercelのSettings → Generalでユーザーが確認したProject IDを登録する。今回設定は行わない。NEXT_PUBLIC_は付けず、実行側VERCEL_PROJECT_IDを独自設定で偽装しない。
欠落・不一致はログなしで405。動的import前にGETで判定し、専用ヘルパーも再確認する。IDだけで環境分離全体を保証するものではなく、期待値は検証用プロジェクトにだけ設定する。

## 第2段階：既存ガードと詳細診断

Project ID一致後、REGISTRATION_PREVIEW_DIAGNOSTIC_GUARDSを1件出力。次の7条件について存在・期待値一致を真偽値で記録する。

- REGISTRATION_DIAGNOSTICS_ENABLED=true（diagnostics_flag_*）
- VERCEL=1（vercel_*）
- NODE_ENV=production（node_env_*）
- VERCEL_ENV=productionまたはpreview（vercel_env_*）
- VERCEL_GIT_REPO_OWNER=gao-dao（repo_owner_*）
- VERCEL_GIT_REPO_SLUG=shinseikai-hub-preview（repo_slug_*）
- VERCEL_PROJECT_PRODUCTION_URL=shinseikai-hub-preview.vercel.app（production_url_*）

分類はGUARD_REJECTED／GUARDS_PASSED。診断フラグが不一致でもID一致なら限定されたガードログは出る。全条件一致した場合だけ既存のREGISTRATION_PREVIEW_DIAGNOSTICSを出力する。Origin形式と既知の検証Origin許可、IPモード・実行環境、x-real-ipの存在と形式、Redis URL・トークン・HMAC・namespace・制限値の形式を記録する。
例外はREGISTRATION_PREVIEW_DIAGNOSTIC_FAILUREとIMPORT_FAILED／COLLECTION_FAILEDのみ。IP取得例外は既存どおりreal_ip_readable=false等に分類する。例外原文は出さない。

## 応答・安全条件

GETは有効・無効・例外とも405、本文なし、Cache-Control: no-store、Allow: POST。POST本文は変更しない。ヘッダー・クエリで有効化条件を上書きできない。Redis通信、Turnstile検証、DB・RPC、登録処理、本文読み取りを行わない。Project IDの値・ハッシュ、設定値・長さ・ハッシュ、IP、トークン、個人情報、ヘッダー全文をログにしない。

## 次の承認後の確認

previewのremote・Vercelプロジェクト・対象commitを確認後、期待IDを検証用の適切な環境に設定し再デプロイする。今回はcommit/push/デプロイ/環境変数変更しない。
GET https://shinseikai-hub-preview.vercel.app/api/registrations を一度だけ実行し、同デプロイのInfoログを見る。405は正常。申込POSTは送らない。
ログなしならProject IDの欠落／不一致、GET未到達、またはログ収集側の問題が残る。ID照合を解除しない。GETの現在状態であり過去POSTの証拠ではない。公開GET連打によるログ・Function費用に注意し短期間に限定する。

## 削除

診断フラグだけを無効にしてもProject ID一致時のガードログは残る。完全停止にはREGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_IDを検証用から削除して再反映する。
その後、route.ts末尾の一時GET全体、lib/security/registration-diagnostics.ts、tests/registration-diagnostics.test.mjs、本手順書を削除。診断フラグも削除し、テスト・型・Lint後に承認を受け検証用へ反映する。既存POST・共有セキュリティモジュールは変更しない。既存ログの保存期間は運用側で確認する。


## HTTP段階ヘッダー（今回追加）

Project ID一致後だけX-Registration-Diagnostic-Stageを返す。

| 固定値 | 意味 |
| --- | --- |
| guard-rejected | 既存ガード不一致。限定ガードログのみ |
| completed | 詳細診断の収集・ログ呼出しが終了。全検査成功や申込成功を意味しない |
| import-failed | 診断ヘルパーの読込失敗 |
| collection-failed | 読込後の診断・ログ処理で例外 |

Project ID欠落・不一致ではヘッダーなし。常に405・本文なし・no-storeを維持。応答にID・IP・設定値・ハッシュ・トークンを出さない。ヘッダーやクエリで分類を指定できない。
次の承認後に検証用へ反映し、GETを1回だけ行い、ブラウザNetworkのResponse Headersで固定値だけ確認する。POSTや外部サービスへの接続は行わない。ヘッダーなしはID不一致や未到達等を区別できず、405だけで原因確定しない。削除時は既存の一時GET全体を削除すればヘッダー処理も撤去される。
