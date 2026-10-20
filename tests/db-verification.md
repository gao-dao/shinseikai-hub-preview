# 隔離DBの復元後メタデータ比較

この検証コードはDBの作成・復元・削除・マイグレーション適用・登録RPC実行を行わない。
単体テストはDockerもDBも使わない。今後の隔離復元手順から比較処理だけを再利用する。

## 単体テスト

```sh
node --test tests/db-verification.test.mjs
```

全回帰テストを実行するときは、隔離DBテストのオプトインを明示的に無効にする。

```sh
SHINSEIKAI_IDEMPOTENCY_DB_TEST=0 node --test tests/*.test.mjs
```

## 次回、承認済みの隔離復元が終わった後の実行方法

次のコマンドは今回まだ実行しない。前回成功した復元方法で一時コンテナを作り、
所有者・ACL・RLSを保持して復元した後、合成データの作成より前に実行する。
一時コンテナには次のいずれかのラベルが必要。

- `shinseikai.rpc-clone-test=true`
- `shinseikai.restore-test=true`

```sh
node scripts/db-verification/verify-restored-db.mjs \
  --restored-container shinseikai-rpc-clone-REPLACE_WITH_ACTUAL_NAME \
  --database restore_check \
  --archive backups/20261019_125918_current_idempotency_rpc_test/database.dump \
  --report backups/NEW_VERIFICATION_DIRECTORY/metadata.json
```

コンテナ名は実際の小文字の名前へ置換する。比較元は `supabase_db_shinseikai-hub` の
`postgres` DBに固定し、コンテナ内の `/var/run/postgresql` ソケットを使用する。
復元先は `/tmp` ソケットを使用する。両方とも `supabase_admin` でカタログを読む。
リモートURL・環境ファイル・Supabase CLIのリンク設定は参照しない。

復元先が元コンテナと同じ場合、イメージが違う場合、ネットワークが `none` でない場合、
公開ポート・既存ボリュームのマウントがある場合は停止する。
レポートは `backups/` 内へ権限600で新規作成し、既存ファイルを上書きしない。
実行後の一時コンテナ削除は、復元を担当する呼出元の `finally` / `trap` で行うこと。

終了コード0かつ `can_run_rpc_tests: true` の場合だけ、その後のRPCテストに進める。
終了コード1、比較不一致、取得エラー、正規化エラーの場合はRPCを実行しない。
比較は全分類の安全な結果を収集してからレポートを保存する。
CLI自体はRPCテストを起動しない。

## 比較範囲と判定

元の12分類に、列、スキーマ、シーケンス定義、シーケンス状態を加えた16分類。

- RPC：public / registration_private の関数・プロシージャと `auth.uid`。
- テーブル、列、RLSポリシー、制約、通常トリガー、インデックス：public / registration_private。
- イベントトリガー、拡張機能、ロール、所属関係、default ACL、シーケンス：クラスタ／DB内の対象。
- スキーマ：public / registration_private の所有者とACL。
- テーブル列：順序、型、NOT NULL、既定値、identity、generated、照合順序。
- すべてのACL：付与先・付与者・権限・再付与可否へ分解して整列。
- default ACL：設定元ロール・スキーマ（グローバルはNULL）・種別を識別子とし、4つの権限属性を比較。空の設定も保持する。
- NULL ACL：`acldefault()` で実効ACLと組み込み既定ACLを取得し、NULLだったかも保持する。テーブル／スキーマで所有者・種別が同じ、分解したACLが同じ、かつ双方が組み込み既定ACLと一致する場合だけ、NULL／明示ACLの違いを `representation_differences` へ記録し、権限の不一致とは分ける。その他のNULL差、空ACL、所有者・付与者・再付与可否・PUBLICの差は不一致として停止する。
- 設定項目の順序だけを無視し、設定値全体、特にsearch_path内の順序は変更しない。
- ロール集合・イベントタグは整列するが、NULLと空配列は区別する。
- SQL定義は固定検索パス・同一版PostgreSQL・非prettyの取得条件で比較。文字列への空白除去・小文字化は行わず、差があれば未解決の定義差として停止する。

各読取は `REPEATABLE READ READ ONLY`、`search_path=pg_catalog`、UTCで実行する。
分類間で完全に同じスナップショットを共有する方式ではないため、比較元を前後に再取得し、
メタデータ変更を検知したら停止する。復元元の定義変更が進行していない時間帯に実行すること。

## シーケンス

バックアップを `pg_restore --list` で読み、復元先の全シーケンスに対応するSEQUENCE SETの
TOC IDを重複・不足・余剰なく選択する。選択リストを `--use-list` に渡して
`pg_restore --data-only --file=-` でSQLテキストを抽出し、実行せず解析する。
保存された `last_value` / `is_called` と復元先を照合する。
二つの入力（アーカイブとTOCリスト）はstdinとbashのプロセス置換用FDで渡す。
既存コンテナ内へ一時ファイルを作らず、psql・採番関数も呼び出さない。
`--table` はリストにある名前との完全一致であり、SQL識別子の引用符を付けた名前は
一致しないため使用しない。同名シーケンスが別スキーマにある場合もTOC IDで区別する。
元DBの現在値の変化は情報として別記し、それだけでは復元失敗にしない。
バックアップの読取・解析失敗は合格にしない。`sequence_baseline` に処理段階と固定の
エラーコード、成功時は選択・解析件数を記録する。比較結果のエラーにも安全なコードを残す。

bigintはSQL側でtextとして取得し、JavaScriptではBigIntで計算する。
次の候補が範囲内で、復元先の関連列の既存IDと衝突せず、既存IDの範囲を越えていることを
SELECTだけで確認する。nextval / setvalを呼び出さない。
関連付けのないシーケンス、採番枯渇、循環による既存ID範囲との重なりは停止して個別確認する。
キャッシュがある場合の候補は保存済み状態に基づく値であり、稼働中セッションのキャッシュ済み値の予測ではない。

## 安全な差分記録

レポート形式は `format_version: 2`。分類、双方の件数、追加・不足・変更の件数、変更フィールド、ACLの変更次元を保存する。
説明できるACL表現差は、件数・双方のNULLフラグ・判定根拠を別途記録する。
オブジェクト識別子と定義ダイジェストは実行ごとの一時鍵によるHMACとし、鍵は保存しない。
同じ実行内で対象を区別できる。固定の許可リストにある既知のアプリ対象だけは
`object_label` に関数名／テーブル名を追加する。未知の識別子を原文で保存しない。
既知のテーブル内の複数の列・制約などは同じラベルでも `object_id` で区別できる。

取得例外のメッセージ・SQL原文・関数定義・設定値・ロールパスワード・キー・参加者情報は
レポートへ出さない。未知のフィールドや重複オブジェクトも正規化エラーとして停止する。

## 今回未実施・対象外

この変更の検証は合成データの単体テストまで。実DBでのSQL実行・復元・RPC動作は次回の承認後に確認する。
全Supabase管理スキーマの全列・全ポリシー、テーブルデータの一致、ログイン・Storageファイル・Vault外部鍵は
このメタデータ比較だけでは検証しない。既存のデータ照合手順は引き続き別途行う。
型・SQL式の意味的同値性は自動証明しない。パーティション専有属性や列単位ACLなど、ここで列挙していない属性の完全な比較も対象外。

## ACLとシーケンス抽出の修正根拠

PostgreSQL 17では、GRANT／REVOKEによってNULL ACLが明示ACLになる。
pg_dumpは組み込み既定ACLからのGRANT／REVOKE差分を保存するため、明示ACLが組み込み既定値と
同じ場合、そのカタログ表現自体は保存されず、復元先はNULLになり得る。
20261019のprivate領域では、実DBの3オブジェクトが非NULLで、バックアップ目録にprivate ACL項目がなく、
前回の照合では分解後の権限が一致していたことを確認済み。

- https://www.postgresql.org/docs/17/ddl-priv.html
- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_dump.c （dumpACL）
- https://www.postgresql.org/docs/17/app-pgrestore.html （--list / --use-list）
- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_backup_archiver.c （_tocEntryRequired）

実バックアップで引用符付き `--table="refresh_tokens_id_seq"` が0文、引用符なしが1文を
抽出すること、目録に8件のSEQUENCE SETがあることを、SQLを実行せずに確認した。
