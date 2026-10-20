# 心勢会HUB リリース対象確認表・本番ビルド事前検証

調査日：2026-10-19。公開準備のみ。commit/push、デプロイ、DB操作、実サービス通信は実行していない。

## Gitの基準と範囲

- ブランチ：`main`。比較先はローカルに保存されている`origin/main`参照。fetchしていないため、現在のリモートや本番Vercelの状態を証明するものではない。
- 4コミット先行。追跡済み未コミット変更2件、調査開始時の未追跡49件。ステージ済み変更0件。
- 4コミットとの差分50ファイルと作業ツリーの変更・未追跡を合わせた分類対象は99ファイル。
- この確認表自体は調査後に追加した未追跡ドキュメントで、上記49件・99件には含めない。調査結果としてGit収録候補。
- 管理者の講習会グループ・予定・申込管理、代理申込が含まれる。公開フォームだけのリリースではない。4コミットの一括pushを前提にしない。

### 先行コミット

- `fd4a680 Implement public event listing and availability`
- `8627e4d Implement admin proxy registration`
- `0990323 Implement admin registration management features`
- `c4c4652 Add registration management database migration`

## 分類の考え方

「Gitに残すもの」と「本番実行時に必要なもの」は区別する。アプリとDB定義はリリース候補、回帰テスト・運用手順もソース管理に残す候補。ローカル専用スクリプトはアプリの実行依存ではないが、関連テストからimportされるため、単純に削除・収録漏れとしない。テスト/検証用ファイルをVercelのアップロード対象から除く運用を採るかは別途判断し、今回は除外設定を変更しない。

- 本番公開に必要なテスト・ドキュメント・保護設定：23件
- 本番公開に必要なアプリコード：43件
- ローカル専用の検証スクリプト・関連テスト/手順書：30件
- 内容・用途の判断が必要：1件
- DBマイグレーション：2件

### ファイル別確認表

| ファイル | 現在の状態 | 分類 | 扱い・確認事項 |
| --- | --- | --- | --- |
| `.gitignore` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 秘密情報・バックアップ・ローカル生成物の除外を維持 |
| `app/(app)/admin/edit-schedule-fields.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/event-groups/event-groups.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/event-groups/page.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/event-groups/registration-control.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/new-schedule-fields.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/page.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/registrations/add-registration-items.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/registrations/cancel-registration-item.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/registrations/page.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/registrations/proxy-registration-form.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/registrations/registration-details-form.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/registrations/registration-list.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/schedule-deletion.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(app)/admin/schedule-registration-status.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/(public)/events/events-list.tsx` | 4先行コミット内／追跡済み・未コミット変更 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `app/(public)/events/page.tsx` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `app/(public)/events/registration-form.tsx` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `app/(public)/events/turnstile-widget.tsx` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `app/api/admin/event-groups/[id]/classes/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/event-groups/[id]/registration/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/event-groups/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/registration-items/[id]/cancel/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/registrations/[id]/items/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/registrations/[id]/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/registrations/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/schedules/[id]/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/admin/schedules/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `app/api/event-groups/[id]/classes/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `app/api/event-groups/route.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `app/api/registrations/route.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/registrations/class-availability.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/registrations/details.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/registrations/proxy-registration.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 代理申込の実装または共有検証/回帰テスト |
| `lib/registrations/public-availability.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/registrations/public-form.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/registrations/public-registration.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/schedules/edit-schedule.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `lib/schedules/new-schedule.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | 管理者機能を含む。今回の公開範囲に含めるか承認が必要 |
| `lib/security/registration-client-ip.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/security/registration-rate-limit.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/security/turnstile.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/supabase/anonymous.ts` | 4先行コミット内 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `lib/supabase/registration-service.ts` | 未追跡 | 本番公開に必要なアプリコード | リリース候補。依存ファイルと一緒に収録し、実設定での結合確認が必要 |
| `scripts/db-verification/compare.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/db-verification/queries.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/db-verification/sequences.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/db-verification/verify-restored-db.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/redis-verification/verify-rate-limit.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-browser/hmr-relay.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-browser/mock-server.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-browser/probe.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-browser/start.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-browser/startup.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-local-real/guard.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-local-real/input.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-local-real/page.tsx.template` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-local-real/proxy.ts.template` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-local-real/route.ts.template` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-local-real/start.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `scripts/turnstile-verification/verify-turnstile.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `supabase/.gitignore` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 秘密情報・バックアップ・ローカル生成物の除外を維持 |
| `supabase/config.toml` | 4先行コミット内 | 内容・用途の判断が必要 | ローカルSupabase設定。本番Vercel不要。設定の用途・運用方針を確認 |
| `supabase/migrations/20261015_add_registration_management.sql` | 4先行コミット内 | DBマイグレーション | Gitへの収録と本番DB適用は別操作。適用履歴・前提条件を要確認 |
| `supabase/migrations/20261019_add_registration_idempotency.sql` | 未追跡 | DBマイグレーション | Gitへの収録と本番DB適用は別操作。適用履歴・前提条件を要確認 |
| `tests/add-registration-items.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/admin-event-groups.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/admin-registrations.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/admin-schedules.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/cancel-registration-item.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/db-verification.md` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/db-verification.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/edit-schedule.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/event-group-registration.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/idempotent-registration-db.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/new-schedule.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/proxy-registration.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 代理申込の実装または共有検証/回帰テスト |
| `tests/public-events.test.mjs` | 4先行コミット内／追跡済み・未コミット変更 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/public-registration-api.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/public-registration-form.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/public-registration.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/redis-rate-limit-verification.md` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/redis-rate-limit-verification.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/registration-client-ip.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/registration-details.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/registration-idempotency.md` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 残す。過去工程の未実装/未適用記述を現在の実装に合わせて整理する |
| `tests/registration-rate-limit.md` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 残す。過去工程の未実装/未適用記述を現在の実装に合わせて整理する |
| `tests/registration-rate-limit.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/schedule-deletion.test.mjs` | 4先行コミット内 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |
| `tests/turnstile-browser-environment.md` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-browser-environment.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-browser-hmr.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-browser-probe.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-browser-startup.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-local-real.md` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-local-real.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-verification.md` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile-verification.test.mjs` | 未追跡 | ローカル専用の検証スクリプト・関連テスト/手順書 | Git保管は可。実行アプリには不要。関連テストがimportするため一括削除しない |
| `tests/turnstile.test.mjs` | 未追跡 | 本番公開に必要なテスト・ドキュメント・保護設定 | 回帰検証用。公開HTTP経路には配置しない |

## 公開対象から除外するもの・秘密情報のファイル名確認

値は読まず、ファイル名・存在・Git追跡/除外状態だけを確認した。

| 対象 | 存在 | Git除外 | 追跡ファイル数 | 扱い |
| --- | --- | --- | --- | --- |
| `.env.local` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `.env.local.backup` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `.env.production-saved` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `.env.supabase-local` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `.env.test-local` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `backups/` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `.next/` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `node_modules/` | 存在 | はい | 0 | Git・本番アップロードから除外 |
| `tsconfig.tsbuildinfo` | 存在 | はい | 0 | Git・本番アップロードから除外 |

- 現在の追跡ファイル名に、`.env*`、秘密鍵用拡張子、credentials/secrets名、`backups/`配下に該当するものは検出されなかった。
- ステージ済みファイルなし。4先行コミットの差分ファイル名にも上記対象はない。
- 通常ソース領域を値を読まずファイル名で走査した結果：`.env.local`（未追跡・Git除外済み）、`.env.local.backup`（未追跡・Git除外済み）、`.env.production-saved`（未追跡・Git除外済み）、`.env.supabase-local`（未追跡・Git除外済み）、`.env.test-local`（未追跡・Git除外済み）。バックアップ・依存関係・既存ビルド出力・Git内部はこの走査から除き、ディレクトリ単位で除外確認した。
- バックアップ本文、環境ファイル、実キーは開いていない。秘密値が通常名のソースに直接埋め込まれていないことや、過去履歴全体の秘密混入までは、このファイル名検査では証明できない。
- 合成テスト用文字列・公開された公式ダミーキーの存在と、実運用キーの混入は区別が必要。今回は実キーとの値比較をしていない。

## 本番ビルドの判断と結果

**`npm run build`は実行しなかった。成功・失敗のビルド結果は未確認。**

確認した`package.json`では`build`は`next build`。prebuild/postbuildスクリプトはない。

実行を止めた理由：

1. `app/layout.tsx`が`next/font/google`のGeist/Geist_Monoを利用。インストール済みNextのGoogle FontsローダーはCSS・フォントファイルを取得する実装。キャッシュを根拠に外部通信が不要とは判断できず、今回の「外部通信が必要なら実行しない」という条件に従った。
2. 通常のリポジトリ直下でのNextビルドは.envファイルを自動読み込みする。プロセス環境にダミー値を設定するだけでは`.env.local`を読まない保証にはならない。
3. Supabaseクライアントをレンダリング中に生成する既存ページもある。後日、隔離コピー・厳格な子環境・接続を遮断する条件で検証すべきで、実設定を使ったビルドは行わない。

現状の完全な本番ビルドを「通信なしで成功」とは報告できない。フォントを置き換えたりNext内部のフォントモックを使えば元のコード/設定の完全なビルド確認ではなくなるため、今回は実行していない。元のアプリコード・設定、既存`.next`、既存サーバーを変更していない。

### 後日のビルド案（未実施・別途判断）

- ソースの明示した許可リストから一時コピーを作成し、.env・バックアップ・既存ビルド出力をコピーしない。
- 環境は必要なOS基本設定と非実サービスのダミー設定だけ。Supabaseは到達不能な検証用URL/ダミーキーとし、実キー・Redis/Turnstile設定は継承しない。テレメトリを無効化する。
- 既存フォント実装を保つなら、Google Fontsへの限定通信の許可とそれ以外の送信遮断を先に設計する。通信許可なしの場合はオフライン用フォント方針を別途承認する。
- 型/Lint成功やフォントを模擬した部分検証と、完全な本番ビルド成功を区別して記録する。

## 公開前の判断・残課題

- 管理者機能・代理申込を今回の公開に含めるか。既存機能のUI/API変更とDB前提も含めて承認する。
- 未追跡の実装・回帰テスト・検証スクリプトの収録範囲。テストがローカルスクリプトに依存する点を維持する。
- `supabase/config.toml`はローカル設定としてGitに残すか。Vercel実行時には不要。本番接続設定として使用しない。
- `20261015`の本番適用状態は未確認。`20261019`はローカル適用済みの記録があるが本番未適用との申告。DB適用はGit収録・デプロイとは別の承認対象。
- 既存のレート制限・冪等性手順書に過去工程の「未実装」「未適用」記述があるため、公開前に整理する。
- 本番向けビルド未実施。Google Fontsの扱いと、環境ファイルを読まない隔離検証方法を決める。
- 実ブラウザ→Vercel IP判定→Redis→Turnstile→隔離DB→管理画面の全経路結合検証。
- 本番ウィジェットのキー組・hostname/action、本番Redisのnamespaceと制限値、本番アクセス経路、秘密設定は未確認。
- 確定業務エラー後のやり直し、結果不明・再読み込み後の問い合わせ手順を確定する。
- 問題時は受付/APIを停止しアプリを既知の版へ戻す。申込履歴・冪等性台帳・HMAC秘密鍵を安易に削除しない。本番バックアップと復旧手順は別途確認する。
