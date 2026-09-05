---
name: stock-skill
description: "股票交易数据管理：同步交易记录、匹配买卖、统计网格收益、查询实时行情、账户收益、排查未匹配记录。触发词：收益、网格收益、赚了多少、同步、匹配、行情、持仓、账户收益、总资产、当日盈亏、未匹配、重跑、profit、stock"
category: finance
---

# 股票交易技能

基于 `opencli stock` 插件获取 Cookie，使用 Node.js 脚本管理股票交易数据。

## 环境

- **脚本目录**：`~/.agents/skills/stock-skill/scripts/`（所有命令必须在此目录下执行）
- **数据库**：`~/.duckdb/stock/stock.db`｜**Cookie 配置**：`~/.duckdb/stock/config`｜**备份**：`~/.duckdb/stock/backup/`
- **Node 版本**：node v24 可正常运行（2026-09 验证）；若遇 DuckDB 原生模块加载错误，先 `npm rebuild`，仍失败再降级 node v20，详见 [references/troubleshooting.md](references/troubleshooting.md)

## 命令总览

| 功能 | 命令 | 说明 |
|------|------|------|
| Cookie 获取 | `opencli stock init` | 通过浏览器获取 Cookie 并写入配置文件 |
| 数据库初始化 | `node init-db.js` | 初始化表结构并同步账户信息（幂等） |
| 交易记录同步 | `node sync.js [start] [end]` | 同步交易记录，日期格式 `YYYYMMDD`；自动分页、重试 3 次、幂等 |
| 交易记录匹配 | `node match.js [start] [end]` | 匹配买入/卖出，范围应 ≤ 同步范围 |
| 收益统计 | `node profit.js [startMonth] [endMonth]` | 查询网格收益，月份格式 `YYYY-MM`；年收益 = 年初至截止月累计 |
| 实时行情 | `node quotes.js [account]` | 持仓实时行情，实时 API 无需同步 |
| 账户收益 | `node account-profit.js [account] [--json]` | 总资产、持有盈亏、当日盈亏，实时 API |
| 未匹配查询 | `node unmatched.js [--code] [--name] [--op] [--start] [--end] [--account]` | 查询未配对交易记录 |
| 数据重置重跑 | `node reset.js [options]` | 备份后删除指定年月记录，可选重跑 sync/match |

**📋 触发词与动作映射**：首次使用/init → 初始化流程；同步、拉取交易 → `sync.js`；匹配、配对 → `match.js`；收益、赚了多少、网格收益 → `profit.js`；行情、持仓、最新价 → `quotes.js`；账户收益、总资产、当日盈亏 → `account-profit.js`；删除、清空、重跑、重算 → `reset.js --dry-run` → 确认 → `--sync --match`。

## 标准工作流

### 场景：首次使用

```bash
# 🔴 STOP · 检查点：首次使用前确认环境
# 执行前询问："首次使用需要初始化，确认继续？"

# 1. 检查 opencli stock 插件是否存在，不存在则自动复制
ls ~/.opencli/plugins/stock/init.js || cp -r ~/.agents/skills/stock-skill/resources/stock ~/.opencli/plugins/stock

# 2. 获取 Cookie
opencli stock init

# 🔴 STOP · 检查点：Cookie 获取后确认
# 执行前询问："Cookie 已获取，确认初始化数据库？"

# 3. 初始化数据库
cd ~/.agents/skills/stock-skill/scripts && node init-db.js
```

### 场景：查看收益（最常用）

```bash
cd ~/.agents/skills/stock-skill/scripts

# 步骤1：同步最新数据（用户说"同步"或"最新"时执行）
node sync.js

# 步骤2：匹配交易记录（步骤1之后必须执行）
node match.js

# 步骤3：统计收益（始终执行）；查单只股票/指定月份加参数即可
node profit.js [YYYY-MM] [YYYY-MM]
```

**执行规则**：
- 用户说"这个月收益" → 直接执行 `node profit.js`
- 用户说"同步并查看收益" / "最新收益" → 按顺序执行 sync → match → profit
- **结果必须以 Markdown 表格输出给用户**（收益/持仓/账户等统计结果均适用），格式见下方「输出格式」

**边界处理：**
- Cookie 过期：同步失败时提示执行 `opencli stock init` 更新 Cookie
- 网络异常：提示检查网络连接后重试
- 无数据：提示是否需要同步历史数据

**输出示例**（仅含盈利配对，无负数；以 Markdown 表格输出给用户）：

```markdown
## 📊 收益统计结果（2026-07）

| 账户 | 代码 | 名称 | 交易次数 | 收益（元） |
|------|------|------|:---:|---:|
| 国泰-冯* | 02269 | 药明生物 | 5 | 5,020.87 |
| 国泰-冯* | 512400 | 有色金属ETF南方 | 6 | 403.26 |

| 项目 | 收益（元） |
|------|---:|
| **月收益（2026-07）** | **6,654.73** |
| 年收益（2026 累计） | 75,942.36 |
```

### 场景：查看持仓实时行情

```bash
cd ~/.agents/skills/stock-skill/scripts
node quotes.js          # 所有账户；node quotes.js 冯 指定账户
```

实时 API，无需提前同步。

### 场景：查看账户收益

```bash
cd ~/.agents/skills/stock-skill/scripts
node account-profit.js            # 所有账户；node account-profit.js 冯 指定账户
node account-profit.js --json     # JSON 格式（便于程序消费）
```

实时调用 `stock_card` 接口，无需提前同步；末尾「汇总」行的当日收益率按 当日盈亏/(总资产-当日盈亏) 加权计算。回复用户时同样转为 Markdown 表格（账户名称/总资产/持有盈亏/当日盈亏/当日收益率 + 汇总行）。

### 场景：重置并重跑某月数据（reset → profit）

用户要求「删除本月/某月的交易记录和匹配记录，重新同步并匹配，再统计收益」时使用 `reset.js`。脚本会先备份数据库，再按年月精确删除两张表的记录，然后重新拉取该时间段的自动存单流水。

```bash
cd ~/.agents/skills/stock-skill/scripts

# 步骤0：预览将被删除的记录数（--dry-run 不写入）
node reset.js --dry-run --start 20260901 --end 20260930

# 🔴 STOP · 检查点：删除前必须确认范围与条数
# 执行前询问："将删除 YYYY-MM 的交易记录 N 条、匹配记录 M 条（已自动备份），确认继续？"

# 步骤1：备份 + 删除 + 重新同步 + 重新匹配
node reset.js --sync --match --start 20260901 --end 20260930

# 步骤2：统计收益
node profit.js 2026-09
```

| 参数 | 说明 |
|------|------|
| `--start` / `--end` | 闭区间，格式 `YYYYMMDD`；缺省为当月 1 日～今天 |
| `--months` | 直接指定年月列表，如 `--months 2026-07,2026-08,2026-09`（优先于 start/end） |
| `--dry-run` | 只输出待删除行数，不做任何修改 |
| `--settle N` | 结束日期往前推 N 天（T+N 结算）。重跑历史月份必用，否则结束日期会落在未来 |
| `--skip-sync` / `--skip-match` | 只删不改，或删后不重新匹配 |
| `--no-backup` / `--force` | 跳过备份 / 忽略进程互斥（均不建议） |

注意：
- 每次执行都会生成 `~/.duckdb/stock/backup/stock.<时间戳>.db`，误删可用它恢复；
- 如果只想让历史配对用上同窗口内新对手盘，不必删数据，直接重跑 `node match.js <start> <end>` 即可；
- 旧版 `purge-month.js` 已被 `reset.js` 取代（且不支持未来日期，会静默删到月末）。

### 场景：同步历史数据

```bash
cd ~/.agents/skills/stock-skill/scripts

# 🔴 STOP · 检查点：同步前必须确认时间范围
# 执行前询问："确认同步 XXXX-XX-XX 至 XXXX-XX-XX 的数据？"

node sync.js 20250101 20260627
# 🔴 STOP · 检查点：匹配前确认同步完成
node match.js 20250101 20260627
```

**🔴 STOP · 检查点：** 大范围同步（超过 3 个月）前必须确认用户意图，避免长时间等待。

### 场景：查询交易记录（DuckDB MCP）

**优先使用 DuckDB MCP 工具直接查询**，不要写 node 脚本。

**MCP工具调用方式：**
```
mcp_mcp_server_duckdb_query(query="SQL语句")
```

**常用查询模板：**

```sql
-- 查询个股交易记录
SELECT account_name, name, code, op, entry_price, entry_count, entry_money, entry_date, entry_time
FROM t_trade_record WHERE name LIKE '%股票名%' ORDER BY entry_date DESC, entry_time DESC LIMIT 20

-- 查询匹配记录
SELECT account_name, name, code, sell_entry_price, buy_entry_count, sell_entry_money, buy_entry_money, profit, sell_time, buy_time
FROM t_trade_matched_record WHERE name LIKE '%股票名%' ORDER BY sell_time DESC LIMIT 20

-- 查询今日交易
SELECT entry_date, entry_time, code, name, op, entry_price, entry_count, entry_money
FROM t_trade_record WHERE entry_date = current_date ORDER BY entry_time
```

**注意：** op='1' 买入，op='2' 卖出。始终用 `op` 字段，不要用 `op_name`。

## 输出格式（回复用户规范）

| 命令 | 输出格式 |
|------|----------|
| profit | 脚本原始输出为纯文本表格；**回复用户时必须转为 Markdown 表格**：个股明细表（账户/代码/名称/交易次数/收益）+ 汇总表（月收益/年收益），金额千分位格式化 |
| quotes | 按账户分组，每组末尾附汇总行，按当日盈亏率降序；转为 Markdown 表格 |
| account-profit | Markdown 表格：账户名称/总资产/持有盈亏/当日盈亏/当日收益率，末尾附汇总行 |
| sync | 成功：记录数+时间范围；失败：提示更新 Cookie |
| match | 成功：匹配数量；部分未匹配：提示原因 |
| reset | 每个年月输出待删/已删行数，备份路径，以及后续 sync/match 结果 |

## 数据速查

| 项目 | 值 |
|------|---|
| 交易记录表 | `t_trade_record` |
| 匹配记录表 | `t_trade_matched_record` |
| 数据库索引 | `idx_trade_op_date`(op,entry_date), `idx_trade_code`, `idx_matched_sell_history`, `idx_matched_sell_time` 等 |
| op='1' / op='2' | 买入 / 卖出（⚠️ 始终用 `op` 数字字段，`op_name` 不可靠） |
| GC001（204001） | 国债逆回购，查询时排除 |

## 注意事项

- 账户超 1000 条自动分页拉取（根据 API 返回的 max_page）
- history_id 基于交易数据生成，确保幂等性
- 手动删记录会绕过幂等保护：删前必备份（`reset.js` 已默认备份）

## 🔴 红线速查

- **不要**手写 SQL DELETE / 手动 INSERT 修改数据 → 用 `node reset.js`（内置备份 + 并发保护）
- **不要**跳过 match 直接查收益（未匹配记录不计入收益）
- **不要**同时运行多个 sync/match/reset 进程（DuckDB 单写者锁会静默丢写入）

完整禁例清单与危险动作见 [references/anti-patterns.md](references/anti-patterns.md)；同步/匹配/收益/行情故障排查见 [references/troubleshooting.md](references/troubleshooting.md)。
