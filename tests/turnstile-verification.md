# Turnstile公式テストキー検証の準備

## 範囲と公式資料

- 既存対象: `lib/security/turnstile.ts`（変更しない）。
- 実行用: `scripts/turnstile-verification/verify-turnstile.mjs`。
- 公式: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- 検証方式: 公式の成功固定・失敗固定・使用済み固定Secret Keyと公式ダミートークン。
- サーバー側Siteverifyだけを検証するため、Site Keyやブラウザは使わない。
- 実ウィジェット、Managed判定、実Site Key／Secret Keyの対応、公開申込の登録処理は検証対象外。

## hostname・actionの不確実性

公式ページの成功レスポンス例は`hostname: localhost`、`action: test`。
しかし、全てのテストSecret Key呼び出しが必ずこのmetadataを返すという保証は確認できない。
失敗例の`invalid-input-response`、使用済み例の`timeout-or-duplicate`も事前条件として固定する。

スクリプトは応答例を実行前の厳密なテスト条件に採用し、保証ではなく仮定としてレポートする。
metadata欠落・不一致・異なるエラー形式は`TEST_RESPONSE_CONTRACT_MISMATCH`で直ちに停止する。
観測後に許可hostnameや期待actionを動的に変更しない。応答を書き換えて成功させない。
実通信で条件が合わない場合は、実装不具合と即断せずテスト条件と公式仕様を再調査する。

## 5ケースと期待

| ケース | Secret Key種別 | モジュール設定 | 期待 |
| --- | --- | --- | --- |
| success | 成功固定 | localhost / test | ok: true |
| rejected | 失敗固定 | localhost / test | TURNSTILE_REJECTED |
| spent | 使用済み固定 | localhost / test | TURNSTILE_REJECTED |
| hostname_mismatch | 成功固定 | not-allowed.example.test / test | TURNSTILE_REJECTED |
| action_mismatch | 成功固定 | localhost / different_action | TURNSTILE_REJECTED |

最後の2ケースは、先にCloudflare応答が成功し、元のhostname・actionが固定条件に一致することを確認する。
Cloudflare側が失敗しているだけでは、不一致検証の成功としない。

## 今回のローカル事前確認

```sh
node --check scripts/turnstile-verification/verify-turnstile.mjs
node scripts/turnstile-verification/verify-turnstile.mjs --mock
node --test tests/turnstile-verification.test.mjs
```

`--mock`は5回の模擬HTTPで5ケースを確認する。外部通信は0回。
コードはTypeScriptから変換した既存モジュールを一時VMで実行し、HTTP部分だけをモックへ差し替える。
本番コードのhostname／action検証を変更しない。

## 次回、実通信が明示承認された場合だけ

```sh
node scripts/turnstile-verification/verify-turnstile.mjs --execute --official-test-keys
```

今回はこのコマンドを実行しない。単独の`--execute`や引数なしでは実行できない。
正常時はHTTPS Siteverify POSTが5回、各ケース1回。自動再試行なし。
既存モジュールの5秒タイムアウトとredirect拒否を維持する。
失敗時は以降のケースをNOT_RUNとして停止する。
テスト値はスクリプト内の公式公開値のみ。実運用値に切り替えるオプションは設けない。

## 情報保護・非変更

`.env.local`や他の環境ファイルはどちらのモードでも読まない／変更しない。
既存プロセスの環境変数を変更せず、ケースごとのVM内に公式テスト設定だけを与える。
ウィジェット設定・公開API・フォームは変更せず、Redis・Supabaseにも接続しない。

結果はケース名、合否、固定のエラー分類、HTTP回数、仮定に関する説明だけ。
テストSecret Key・トークン・Cloudflare応答原文・例外原文を出力しない。
レポートのlocalhost／testは事前定義した公開テスト条件であり、実設定から取得した値ではない。
既存モジュールの前後ハッシュ一致も確認する。新しい診断ログやファイルは自動作成しない。

## フィールド別診断（実通信は別途承認後）

前回の`TEST_RESPONSE_CONTRACT_MISMATCH`は、HTTP 200確認とJSON解析の後で発生している。
従ってHTTPエラー・JSON構文エラーではなく、JSONのルート構造または内容の不一致まで絞れる。
前回の応答原文は保存していないため、原因フィールドは遡及的には特定できない。

今回から各実行済みケースの`diagnostics`に以下だけを追加する。

- `http_status`: HTTPコード。未受信の場合NULL。
- `json_parsed`: 解析成功true／失敗false／未実施NULL。
- `success`: true／false／invalidの固定分類（文字列）。
- `hostname_matches`、`action_matches`: 事前固定したprofileとの一致。未確認はNULL。
- `fields`: bodyとsuccess／hostname／action／error-codesの有無と型だけ。
- `mismatched_fields`: 固定フィールド名の配列。body、success、hostname、action、error-codes、http_status、json。

hostnameとactionの実応答値、エラーコード配列の内容、未知の追加フィールドは保存しない。
`profile`に載るlocalhost／testは引き続き事前定義したテスト前提であり、実応答値ではない。
未解析のフィールドはpresent=NULL／type=not_checkedとし、欠落と混同しない。
成功応答に必須のhostname／actionが失敗応答にない場合は、それだけで契約違反にはしない。
エラー配列の長さ・内容の検証は維持し、相違があれば値を残さずerror-codesの不一致と記録する。
本番の検証関数・テスト条件・停止条件を緩めていない。
