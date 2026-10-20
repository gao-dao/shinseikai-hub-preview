# 検証用リポジトリ コピー対象確認表

調査日：2026-10-20（日本時間）。元：shinseikai-hub、予定先：shinseikai-hub-preview。
今回は一覧作成と静的検査のみ。コピー、Git init/add/commit/push、外部通信、DB操作は未実施。
秘密情報ファイルは開いていない。アプリコードと既存設定は変更していない。

## 件数・基準

- `git ls-files -z`：80件。`git ls-files --others --exclude-standard -z`：50件。初期候補130件、重複なし。
- 初期候補：コピー対象128件、コピー不要1件、判断保留1件。
- この確認表自身をコピー対象に追加：最終コピー対象129件、不要1件、保留1件、計131件。
- main、ローカルorigin/mainより4コミット先行。追跡変更2件、ステージ済み0件。fetchは実行していない。
- 先行コミットに管理者申込管理・代理申込・公開一覧・DB定義を含む。最新の未コミット／未追跡実装も選別対象とする。
- コピー対象は現在の作業ツリーの内容。Git履歴、隔離ビルドのフォント差替え版は持ち込まない。

## 既存リリース確認表との照合

`docs/release-readiness-20261019.md` の個別ファイル行と照合し、今回候補のうち99件が記載済み。既存表は先行コミット差分等を中心とした表であり、今回の全作業ツリー一覧とは範囲が異なる。既存表の通常ファイル行で今回候補にないもの：0件。今回の確認表も追加する。

## 依存関係・ファイル形式検査

- 候補130件にシンボリックリンク・欠落ファイルなし。外部参照リンク0件。
- TS/TSX/JS/MJSの静的ローカルimportを107件解決し、未解決0件。
- テストが参照するscripts、テンプレート、3マイグレーションを保持する。テンプレート内の生成後パスは起動スクリプトの生成処理と対応する。
- 動的文字列、モック内のrequire名、生成後ファイルは静的importと区別した。今回テストの再実行・ビルドはしていない。
- package.jsonとlockfile、app/lib/public、型・Lint・PostCSS・Next設定を含める。node_modulesは移送しない。
- supabase/config.tomlはアプリ実行依存ではなく、現在のローカルプロジェクト識別子・ポート・認証URLをそのまま使わせないため保留。

## 秘密情報検査（値・原文は記録しない）

候補の通常テキストのみを読み、秘密鍵ヘッダー、JWT形式、GitHubトークン、Supabase秘密キー形式、プロバイダーキー、認証情報付き接続URL、Bearer固定値、秘密項目への文字列直接代入を検査した。バイナリfaviconは内容のテキスト検査対象外。環境ファイル・バックアップ・Git履歴・依存関係は開いていない。

- 鍵／JWT／プロバイダートークン／認証情報付きURLなどの高確度パターン：0件。
- 一般的な秘密項目の固定値候補：19件。追加の大文字環境変数固定値規則：11件。規則間の重複を含む検出延べ件数であり、秘密情報30件という意味ではない。
- 下表の候補はテスト／モックの合成値、拒否確認用入力、設定コメント／環境変数参照。実運用秘密情報と断定するものは検出されなかった。Cloudflare公式ダミーキーと実キーは区別する。
- 実キーとの値照合はしていない。任意形式の埋込み秘密情報を完全に否定する検査ではない。push直前にも同じ検査とステージ対象検査が必要。

| ファイル | 検出区分 | 件数 | 判定 |
| --- | --- | ---: | --- |
| `supabase/config.toml` | 一般固定値候補 | 3 | コメント・環境変数参照。ファイル自体は保留 |
| `tests/db-verification.test.mjs` | 一般固定値候補 | 1 | 合成値 |
| `tests/public-registration-api.test.mjs` | 一般固定値候補 | 1 | 合成値 |
| `tests/registration-client-ip.test.mjs` | 一般／大文字固定値候補 | 1 / 1 | 合成値 |
| `tests/registration-rate-limit.test.mjs` | 一般／大文字固定値候補 | 2 / 2 | 合成値 |
| `tests/turnstile-browser-hmr.test.mjs` | 一般固定値候補 | 1 | 合成値 |
| `tests/turnstile-browser-probe.test.mjs` | 一般固定値候補 | 1 | 合成値 |
| `tests/turnstile-local-real.test.mjs` | 一般／大文字固定値候補 | 4 / 3 | 合成値・二重送信／回数上限確認用入力 |
| `tests/turnstile-verification.test.mjs` | 一般固定値候補 | 3 | 合成値 |
| `tests/turnstile.test.mjs` | 一般固定値候補 | 2 | 合成値 |
| `scripts/redis-verification/verify-rate-limit.mjs` | 大文字固定値候補 | 1 | モック用合成値 |
| `tests/redis-rate-limit-verification.test.mjs` | 大文字固定値候補 | 1 | 合成値 |
| `tests/turnstile-browser-environment.test.mjs` | 大文字固定値候補 | 3 | 環境引継ぎ拒否テスト用合成値 |

## 明示的除外（初期130候補には含まれない）

`.git/`、全階層の`.env*`、`.npmrc`、`.vercel/`、秘密鍵・認証ファイル、backups/、DBデータ・dump、supabase/.temp/・.branches/・snippets/、node_modules/、.next/、out/、build/、coverage/、キャッシュ、ログ、*.tsbuildinfo、生成next-env.d.tsを除外する。
既存.gitignoreを継承するが、それだけに依存せず、コピー時に同じ禁止条件を再適用する。名前が通常ソースでも秘密情報が検出された場合はコピーを停止する。

## 全ファイル確認表

| ファイル | Git状態 | 区分 | 理由・既存表との関係 |
| --- | --- | --- | --- |
| `.gitignore` | 追跡済み | コピー対象 | 秘密情報・生成物のGit除外設定を維持。 既存表に記載 |
| `README.md` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `app/(app)/admin/edit-schedule-fields.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/event-groups/event-groups.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/event-groups/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/event-groups/registration-control.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/new-schedule-fields.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/registrations/add-registration-items.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/registrations/cancel-registration-item.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/registrations/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/registrations/proxy-registration-form.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/registrations/registration-details-form.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/registrations/registration-list.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/schedule-deletion.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/admin/schedule-registration-status.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(app)/layout.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(app)/schedule/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(app)/videos/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(auth)/login/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(auth)/register/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(auth)/reset-password/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(auth)/update-password/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/(public)/events/events-list.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(public)/events/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(public)/events/registration-form.tsx` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/(public)/events/turnstile-widget.tsx` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/change-password/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/api/admin/event-groups/[id]/classes/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/event-groups/[id]/registration/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/event-groups/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/registration-items/[id]/cancel/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/registrations/[id]/items/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/registrations/[id]/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/registrations/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/schedules/[id]/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/admin/schedules/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/auth/get-email-by-role/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/api/event-groups/[id]/classes/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/event-groups/route.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/api/registrations/route.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `app/favicon.ico` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/globals.css` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/layout.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `app/page.tsx` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `docs/release-readiness-20261019.md` | 未追跡 | コピー対象 | 選別根拠となる既存リリース確認記録。過去時点の記述は現状と区別。 既存表の個別行対象外 |
| `eslint.config.mjs` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `lib/registrations/class-availability.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/registrations/details.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/registrations/proxy-registration.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/registrations/public-availability.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/registrations/public-form.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/registrations/public-registration.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/schedules/edit-schedule.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/schedules/new-schedule.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/security/registration-client-ip.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/security/registration-rate-limit.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/security/turnstile.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/supabase/anonymous.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/supabase/client.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `lib/supabase/registration-service.ts` | 未追跡 | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表に記載 |
| `lib/supabase/require-admin.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `lib/supabase/server.ts` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `next.config.ts` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `package-lock.json` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `package.json` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `postcss.config.mjs` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `public/file.svg` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `public/globe.svg` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `public/next.svg` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `public/vercel.svg` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `public/window.svg` | 追跡済み | コピー対象 | アプリ本体・共通処理・静的アセット。管理者・代理申込機能も含む。 既存表の個別行対象外 |
| `scripts/db-verification/compare.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/db-verification/queries.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/db-verification/sequences.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/db-verification/verify-restored-db.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/redis-verification/verify-rate-limit.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/setup-member-account.mjs` | 追跡済み | コピー不要 | 会員共有アカウントをDBへ作成する運用スクリプト。アプリ・テストからの参照なし。今回は検証用ソース複製から除外。 既存表の個別行対象外 |
| `scripts/turnstile-browser/hmr-relay.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/turnstile-browser/mock-server.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/turnstile-browser/probe.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/turnstile-browser/start.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/turnstile-browser/startup.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `scripts/turnstile-local-real/guard.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 localhost実認証用。キーを含まないコードのみ。 既存表に記載 |
| `scripts/turnstile-local-real/input.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 localhost実認証用。キーを含まないコードのみ。 既存表に記載 |
| `scripts/turnstile-local-real/page.tsx.template` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 localhost実認証用。キーを含まないコードのみ。 既存表に記載 |
| `scripts/turnstile-local-real/proxy.ts.template` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 localhost実認証用。キーを含まないコードのみ。 既存表に記載 |
| `scripts/turnstile-local-real/route.ts.template` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 localhost実認証用。キーを含まないコードのみ。 既存表に記載 |
| `scripts/turnstile-local-real/start.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 localhost実認証用。キーを含まないコードのみ。 既存表に記載 |
| `scripts/turnstile-verification/verify-turnstile.mjs` | 未追跡 | コピー対象 | 回帰テストまたは検証手順で利用する検証コード。コピーは実行許可を意味しない。 既存表に記載 |
| `supabase/.gitignore` | 追跡済み | コピー対象 | 秘密情報・生成物のGit除外設定を維持。 既存表に記載 |
| `supabase/config.toml` | 追跡済み | 判断保留 | 既存project_id・ポート・認証URLを持つローカルCLI設定。検証専用DBの方針決定後に別途扱う。アプリ・静的importの依存先ではない。 既存表に記載 |
| `supabase/migrations/20260918_initial_baseline.sql` | 追跡済み | コピー対象 | DB定義の再現用。コピーしても自動適用しない。 既存表の個別行対象外 |
| `supabase/migrations/20261015_add_registration_management.sql` | 追跡済み | コピー対象 | DB定義の再現用。コピーしても自動適用しない。 既存表に記載 |
| `supabase/migrations/20261019_add_registration_idempotency.sql` | 未追跡 | コピー対象 | DB定義の再現用。コピーしても自動適用しない。 既存表に記載 |
| `tests/add-registration-items.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/admin-event-groups.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/admin-registrations.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/admin-schedules.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/cancel-registration-item.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/db-verification.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/db-verification.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/edit-schedule.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/event-group-registration.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/idempotent-registration-db.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/new-schedule.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/proxy-registration.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/public-events.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/public-registration-api.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/public-registration-form.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/public-registration.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/redis-rate-limit-verification.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/redis-rate-limit-verification.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/registration-client-ip.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/registration-details.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/registration-idempotency.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/registration-rate-limit.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/registration-rate-limit.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/schedule-deletion.test.mjs` | 追跡済み | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-browser-environment.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-browser-environment.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-browser-hmr.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-browser-probe.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-browser-startup.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-local-real.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-local-real.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-verification.md` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile-verification.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tests/turnstile.test.mjs` | 未追跡 | コピー対象 | 既存機能・公開申込の回帰テスト／検証手順。 既存表に記載 |
| `tsconfig.json` | 追跡済み | コピー対象 | アプリの依存固定・ビルド・型検査・Lint設定またはREADME。 既存表の個別行対象外 |
| `docs/preview-copy-manifest-20261020.md` | 今回作成 | コピー対象 | 今回追加するコピー確認表。初期130候補外の追加1件。 既存表の個別行対象外 |

## 複製前の残課題

1. 判断保留のsupabase/config.tomlを複製しないまま進むか、検証専用DB方針に沿って後日整備するか決定する。保留中はコピーしない。
2. コピー直前に候補とハッシュを再取得し、現在の一覧からの追加・変更を確認する。今回の検査はこの時点のスナップショット。
3. コピー先で禁止ファイル・リンク・秘密情報を再検査する。新規リポジトリには元.gitを持ち込まず、remoteは検証用のみとする。
4. 検証用VercelのDB・外部サービス・環境変数の分離は別途実施。マイグレーションはソース保存のみで、コピー／pushに伴って適用しない。
5. 検証スクリプトはコピーしても自動実行しない。全経路結合テスト・本番向けビルドの成功を本確認表で証明しない。

コピーは未実施。次の指示を待つ。
