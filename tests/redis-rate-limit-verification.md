# Redis実動作検証スクリプトの準備

対象: `scripts/redis-verification/verify-rate-limit.mjs`

前回はstdinの一時スクリプトが未完のまま終わり、外側のtry文と後続処理が閉じられず、
`Unexpected end of input`になった。ファイルとして保存されていないため、今回は再作成した。
既存のレート制限モジュールは変更していない。

## 今回実行できるローカル確認

```sh
node --check scripts/redis-verification/verify-rate-limit.mjs
node scripts/redis-verification/verify-rate-limit.mjs --mock
node --test tests/redis-rate-limit-verification.test.mjs
```

importと`--mock`は`.env.local`を読まず、実fetchも使用しない。
モックはRedisの応答と状態を模擬するもので、実際のLuaエンジンの動作保証ではない。
10項目の判定、エラー中断、後片付け、秘密情報を含まない報告を準備段階で確認する。

## 次回、実通信が承認された場合だけ実行

```sh
node scripts/redis-verification/verify-rate-limit.mjs \
  --execute --confirm-project-target shinseikai-hub
```

今回はこのコマンドを実行しない。
実行時だけプロジェクト直下の`.env.local`を読み、URL・token・専用HMAC秘密値を使う。
接続先がこのプロジェクト向けであることは、実行前に管理者がUpstash管理画面で確認する。
スクリプトはクラウドの所有プロジェクトを自動検証できず、管理APIにも接続しない。
環境ファイルと既存モジュールの変更を行わず、秘密値・URL・生IP・キー一覧・Lua原文を報告しない。
保存が必要なら標準出力の安全なJSONだけをGit除外済みの新しい場所へ保存する。

## テスト領域と判定

- 毎回ランダムな`rlcheck-<16桁hex>-<scenario>`を使う。既存namespaceを流用しない。
- 合成IPv4は文書用192.0.2.0/24、IPv6は2001:db8::/32。
- TypeScriptの既存モジュールを読み取り、実際の関数を一時VMで呼び出す。
- EVAL本文・制限窓60秒／3600秒／60秒は変更せず検証する。
- 制限値だけテスト用に小さくする。毎分制限2、毎時制限2、全体制限2、並行上限3の4ケース。
- 同一キー相当のIPv6表記違い・IPv4-mapped IPv6も確認する。
- 各関数呼び出しの生のLua結果と、実装関数が返す許可／拒否・Retry-Afterを照合する。
- 8並行呼び出しは上限3だけ許可されることを確認する。失敗しても開始済み処理はsettleしてからcleanupする。

## TTLと後片付け

実装自体のTTLは固定で、テスト設定から短縮できない。
そのためEVAL直後に、今回の処理から把握した新規キーだけを`PEXPIRE 30000`で短縮する。
並行呼び出しは短縮前の本来のTTLを読むこともあるため、Retry-Afterはその生の戻り値と比較する。
最後に既知の18キーへPTTLを実行し、存在する16キーが30秒以下であることを確認する。
拒否されたIPの2キーは生成されない。

終了時は成功・失敗にかかわらず、把握した今回のキーだけをDELし、同じキーへのEXISTSで0を確認する。
SCAN・KEYS・FLUSH等は使わない。エラー時にテストケースを再試行しない。
cleanupは再試行ではなく、許可されたテスト領域の削除として実行する。

プロセス強制終了や通信断ではTTL短縮／削除の完了は保証できない。
短縮前に停止すると実装本来の最大1時間TTLが残る可能性がある。失敗時はcleanup結果も確認すること。

## 正常時の操作量

- HTTPリクエスト31回（21 EVAL、7保守pipeline、1 PTTL pipeline、DEL、EXISTS）。
- 送信するトップレベルRedisコマンド59個:
  EVAL 21、PEXPIRE 18、PTTL 18、DEL 1、EXISTS 1。
- Lua内部のGET／PTTL／INCR／PEXPIREは推定175回。課金上の集計方法を意味しない。
- 許可11、拒否10。生成16キー、削除後0キー。
- 安全上限はHTTP40回、トップレベル80コマンド。無制限の繰り返しはない。

実接続・Lua実行・本番での共有状態は次回承認後の未確認事項。
