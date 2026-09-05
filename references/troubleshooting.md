# 故障排除手册

> SKILL.md 的详细排障参考。按症状定位，按顺序检查。

## 同步失败

**症状**：`node sync.js` 报错或返回空数据

**检查顺序**：
1. **Cookie 是否过期？** → 检查 `~/.duckdb/stock/config` 文件修改时间，超过 24 小时执行 `opencli stock init`
2. **网络是否正常？** → 执行 `curl -s https://tzzb.10jqka.com.cn` 测试连通性
3. **日期格式是否正确？** → 必须是 `YYYYMMDD`，如 `20260627`
4. **脚本目录是否正确？** → 必须在 `~/.agents/skills/stock-skill/scripts/` 下执行
5. **是否 API 限流？** → 等待 30 秒后重试，脚本内置 3 次重试
6. **是否并发冲突？** → 检查是否有其他 sync 进程运行：`ps aux | grep sync.js`。两阶段同步（并行 API → 顺序 DB 写入）已避免单进程内的锁冲突，但仍不能同时运行两个 sync 进程

**回退方案**：如果同步失败，数据不会丢失，可重新执行。

## 匹配失败

**症状**：`node match.js` 匹配数量为 0

**检查顺序**：
1. **是否已同步？** → 先执行 `node sync.js` 确保有数据
2. **时间范围是否匹配？** → match 的日期范围必须覆盖 sync 的日期范围
3. **数据库是否有数据？** → 执行 `~/.local/bin/duckdb ~/.duckdb/stock/stock.db -c "SELECT count(*) FROM t_trade_record;"`

## 收益查询失败

**症状**：`node profit.js` 返回空或报错

**检查顺序**：
1. **是否已匹配？** → 先执行 `node match.js`
2. **月份格式是否正确？** → 必须是 `YYYY-MM`，如 `2026-06`
3. **该月是否有数据？** → 检查 `t_trade_matched_record` 表是否有该月数据

## 收益比预期少（怀疑同步/匹配遗漏）

**症状**：`node profit.js` 有记录但金额明显偏低，或 `sync.js` 输出的记录数异常少。

**常见原因：DuckDB 单写者锁冲突。** sync/match/reset 都打开同一个数据库，并发运行时会出现「写入成功但行数不增」或 `Cannot open a connection ... while other connection is opened`。sync.js 已改为两阶段写入来缓解，但仍必须保证同时只有一个写进程。

**检查顺序**：
1. **是否有并发进程？** → `pgrep -af "(sync|match|purge-month|reset)\.js"`；有则等它跑完再重跑
2. **Cookie 是否过期？** → 检查 `~/.duckdb/stock/config` 修改时间，超过 24 小时执行 `opencli stock init`
3. **API 返回是否为空？** → `curl` 拉一次存单接口看 `errcode`/`total`（正常 `errcode:0`、`success:true`），区分"真没交易"和"鉴权/限流失败"
4. **本地记录与 API 不一致？** → 用 `node reset.js --dry-run --months YYYY-MM` 比对行数，再 `node reset.js --sync --match --months YYYY-MM` 重跑该月
5. **仍未恢复？** → 从 `~/.duckdb/stock/backup/` 取最近一份备份覆盖后全量重跑

## 行情获取失败

**症状**：`node quotes.js` 报错或返回空

**检查顺序**：
1. **Cookie 是否过期？** → 执行 `opencli stock init` 更新
2. **网络是否正常？** → 检查网络连接
3. **账户是否有持仓？** → 确认股票账户有持仓股票

## 数据库损坏

**症状**：各种 SQL 错误

**处理**：
1. 备份：`cp ~/.duckdb/stock/stock.db ~/.duckdb/stock/stock.db.bak`
2. 重新初始化：`node init-db.js`
3. 重新同步：`node sync.js 20250101 $(date +%Y%m%d)`
4. 重新匹配：`node match.js 20250101 $(date +%Y%m%d)`

## Node 版本与 DuckDB 原生模块

当前环境 node v24 可正常运行所有脚本（2026-09 验证）。若遇到 DuckDB 原生模块加载错误（如 `ERR_DLOPEN_FAILED` 或 ABI 不匹配），按以下顺序处理：

1. `cd ~/.agents/skills/stock-skill/scripts && npm rebuild`
2. 仍失败则切换 node v20：`mise exec node@20 -- node profit.js`（若安装了 mise）
