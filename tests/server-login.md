# サーバーログインの検証・反映前条件

利用者操作は会員／管理者の選択とパスワード入力のまま。認証は公開キーによるSupabase Auth。メール取得APIは410で廃止。

## 必須設定（検証用プロジェクトのみ）

- ADMIN_LOGIN_EMAIL: 現在使っている1管理者アカウントの正確なメール。未設定は管理者ログイン拒否。別アカウントへ変更しない。
- MEMBER_SHARED_EMAIL: 既存の会員共通アカウント。管理者とは別のアドレス。
- NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 検証用Supabase。秘密キーによる認証・メール検索はしない。
- Vercel Firewall: POST /api/auth/login 用に試行回数制限を設定・有効化してからデプロイする。申込用ルールは適用されない。暫定案はIP別10回/60秒、429（共用IPへの影響を確認して決定）。Supabase Auth標準制限も維持する。分散攻撃・共通アカウントへの攻撃はIP制限だけでは防げない。
- Supabase URL Configuration: 検証用Site URLと /update-password のRedirect URL、メールテンプレートを確認。設定操作やメール送信は今回行わない。

## 自動テスト

node --test tests/server-login.test.mjs tests/admin-access-boundaries.test.mjs tests/auth-login-reset.test.mjs

外部通信は明示的なモックのみ。実SSRライブラリのCookie形式についても、モックtransportでログイン→ブラウザ読込→更新→サーバー認可→localログアウトを検証する。Cookieやトークンを出力しない。

## 実ブラウザ（別途承認後）

1. 検証用会員・管理者で各1回ログイン。メール入力不要・/videosへの遷移と再読込を確認。管理者のみ管理画面へ入れること。
2. セッション更新後も管理画面とAPIが動き、ログアウト後に管理画面・APIが拒否されること。既存セッションを持った状態からの切替も確認。
3. 旧メール取得APIが410で個人情報を返さず、ログイン用Firewallが429を返すことを別途安全な計画で確認。認証後の標準Cookieにはユーザー情報が含まれ得るため、ログや作業記録へコピーしない。

## 制約

事前のメール公開は廃止するが、認証後の標準Supabaseセッションをブラウザでも利用するため、本人のメールが認証済みセッションから読める場合はある。HttpOnly一律変更はしない。パスワードはtrimせず送信。API本文には成功真偽または固定エラーだけを返す。Cookie書き込み失敗は成功応答を破棄する。

旧ログインへ戻してメール公開を再開する運用は避ける。移行失敗時は追加試行を止め、設定とセッションを検証する。本番環境は操作しない。
