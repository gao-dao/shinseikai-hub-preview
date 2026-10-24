# 開催中止・非表示のローカル検証

対象は検証用リポジトリのみ。クラウドSupabaseへの接続やSQL適用は行わない。

## モック検証

```sh
node --test tests/event-group-lifecycle.test.mjs tests/admin-event-groups.test.mjs tests/public-events.test.mjs tests/occurrence-overview.test.mjs tests/admin-event-group-screen.test.mjs
```

API認可・Origin・入力・履歴件数確認・競合・非再送、通常／非表示一覧、公開取得条件とスケジュールの中止表示を確認する。実メール・トークン・実申込を使用しない。

## 隔離DB検証

Docker DesktopのローカルUnixソケット接続、Engine稼働、既存イメージ `ghcr.io/supabase/postgres:17.11.0.004` を確認後に実行する。

```sh
SHINSEIKAI_LIFECYCLE_DB_TEST=1 node --test tests/event-group-lifecycle-db.test.mjs
```

専用 `shinseikai-lifecycle-*` コンテナのみを作成する。`--pull=never`、`--network none`、TCP待受なし、コンテナ内Unixソケット接続。一時DBの合成データのみ書き込む。`t.after()`の停止と`--rm`で削除する。既存コンテナには操作しない。Engineに接続できない場合は無理に実行しない。

履歴保持、状態競合、一般／代理／クラス追加の拒否、受付再開のDB制約、匿名・会員RLS、管理者の隠れた履歴閲覧、公開SECURITY DEFINER RPC、成功済みキー再送、状態変更と申込の両方のロック順序を検証する。

## 適用前のレビュー事項

- 新SQLは `20261026_add_event_group_lifecycle.sql`。20261024・20261025と既存申込／冪等性マイグレーションが前提。
- 保留中の削除SQLは不要で、適用しない。
- 適用時は列・制約・トリガー・関数・RLS定義のみ。申込や取消履歴を更新しない。
- 再実行は非対応。全文がBEGIN/COMMITの単一トランザクション。エラー時に再実行せず、ロールバック状態と作成済みオブジェクトを確認する。
- 既存のロール継承、全SELECTポリシー、関数所有者・EXECUTE権限を検証用環境で別途確認する。
- 状態変更時のみ受付を停止する。中止の解除はDBトリガーでも禁止。非表示解除は受付を再開しない。
- 既存の成功済みキーは履歴の再確認だけ行う。新規登録・追加は共通DB関数で拒否する。
- 非表示は過去にブラウザへ配信した情報を消去する仕組みではない。画面の再取得前に表示が残る場合がある。
- 確認画面の履歴件数は取得時点の値。並行して既に確定した申込は保持されるため、中止後は申込一覧を再確認して連絡する。

## 最小の実ブラウザ確認（別途許可後）

合成データのみ使用し、中止／非表示確認文、通常一覧からの除外、非表示一覧からの詳細・再表示、再表示後の受付停止維持、会員スケジュールの中止表示を確認する。申込者への連絡は自動実施しない。
