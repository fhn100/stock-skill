---
name: stock-skill
description: "股票交易数据管理：同步交易记录、匹配买卖、统计网格收益、查询实时行情。触发词：收益、同步、匹配、行情、持仓、profit、stock"
category: finance
---

# 股票交易技能

基于 `opencli stock` 插件获取 Cookie，使用 Node.js 脚本管理股票交易数据。

## 脚本目录

`~/Workspace/personal/stock-skill/scripts/`

## 功能概览

| 功能 | 脚本 | 说明 |
|------|------|------|
| Cookie 获取 | `opencli stock init` | 通过浏览器获取 Cookie 并写入配置文件 |
| 数据库初始化 | `node init-db.js` | 初始化表结构并同步账户信息 |
| 交易记录同步 | `node sync.js [start] [end]` | 同步指定时间范围的交易记录 |
| 交易记录匹配 | `node match.js [start] [end]` | 匹配买入/卖出记录 |
| 收益统计 | `node profit.js [startMonth] [endMonth]` | 查询网格收益 |
| 实时行情 | `node quotes.js [account]` | 获取持仓实时行情 |

## 触发词与动作映射

| 用户意图 | 触发词 | 执行动作 |
|---------|--------|---------|
| 首次使用 | 初始化、init | 检查插件 → `opencli stock init` → `node init-db.js` |
| 同步数据 | 同步、拉取交易、更新数据 | `node sync.js [起止日期]` |
| 匹配记录 | 匹配、配对、买卖匹配 | `node match.js [起止日期]` |
| 查看收益 | 收益、赚了多少、profit、网格收益 | `node profit.js [月份]` |
| 实时行情 | 行情、实时行情、持仓行情、股票行情、最新价 | `node quotes.js [账户]` |
| 持仓查询 | 持仓、现在持有、手里有什么股票 | `node quotes.js` |

## 标准工作流

### 场景：首次使用

```bash
# 🔴 STOP · 检查点：首次使用前确认环境
# 执行前询问："首次使用需要初始化，确认继续？"

# 1. 检查 opencli stock 插件是否存在，不存在则自动复制
ls ~/.opencli/plugins/stock/init.js || cp -r ~/Workspace/personal/stock-skill/resources/stock ~/.opencli/plugins/stock

# 2. 获取 Cookie
opencli stock init

# 🔴 STOP · 检查点：Cookie 获取后确认
# 执行前询问："Cookie 已获取，确认初始化数据库？"

# 3. 初始化数据库
cd ~/Workspace/personal/stock-skill/scripts && node init-db.js
```

### 场景：查看收益（最常用）

```bash
cd ~/Workspace/personal/stock-skill/scripts

# 步骤1：同步最新数据（用户说"同步"或"最新"时执行）
node sync.js

# 步骤2：匹配交易记录（步骤1之后必须执行）
node match.js

# 步骤3：统计收益（始终执行）
node profit.js [YYYY-MM] [YYYY-MM]
```

**执行规则**：
- 用户说"这个月收益" → 直接执行 `node profit.js`
- 用户说"同步并查看收益" → 按顺序执行 sync → match → profit
- 用户说"最新收益" → 按顺序执行 sync → match → profit

**边界处理：**
- Cookie 过期：同步失败时提示执行 `opencli stock init` 更新 Cookie
- 网络异常：提示检查网络连接后重试
- 无数据：提示是否需要同步历史数据

### 场景：查看某只股票收益

```bash
cd ~/Workspace/personal/stock-skill/scripts
node profit.js 2026-04
```

**输出示例**：
```
📊 收益统计结果：
──────────────────────────────────────────────────────────────────────
账户          时间        股票代码      股票名称        交易次数    总收益
──────────────────────────────────────────────────────────────────────
国泰-冯*       2026-04   601012    隆基绿能        5       212.40
国泰-冯*       2026-04   159841    证券ETF       8       -426.64
国泰-冯*       2026-04             月收益                 -214.24
国泰-冯*       2026-04             年收益                 15468.01
──────────────────────────────────────────────────────────────────────
```

### 场景：查看持仓实时行情

```bash
cd ~/Workspace/personal/stock-skill/scripts

# 获取所有账户持仓行情
node quotes.js

# 获取指定账户行情
node quotes.js 冯
```

**注意：** 此命令会实时调用 API 获取最新行情数据，无需提前同步。

### 场景：同步历史数据

```bash
cd ~/Workspace/personal/stock-skill/scripts

# 🔴 STOP · 检查点：同步前必须确认时间范围
# 执行前询问："确认同步 XXXX-XX-XX 至 XXXX-XX-XX 的数据？"

# 同步 2025 年至今所有数据
node sync.js 20250101 20260627

# 🔴 STOP · 检查点：匹配前确认同步完成
# 执行前询问："同步已完成，确认匹配这些数据？"

# 然后匹配
node match.js 20250101 20260627
```

**🔴 STOP · 检查点：** 大范围同步（超过 3 个月）前必须确认用户意图，避免长时间等待。执行前询问："确认同步 XXXX-XX-XX 至 XXXX-XX-XX 的数据？这可能需要较长时间。"

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
SELECT account_name, name, code, buy_price, buy_count, sell_price, sell_count, profit, buy_date, sell_date
FROM t_trade_matched_record WHERE name LIKE '%股票名%' ORDER BY sell_date DESC LIMIT 20

-- 查询今日交易
SELECT entry_date, entry_time, code, name, op, entry_price, entry_count, entry_money
FROM t_trade_record WHERE entry_date = current_date ORDER BY entry_time
```

**注意：** op='1' 买入，op='2' 卖出。始终用 `op` 字段，不要用 `op_name`。

## 命令参考

| 命令 | 参数 | 说明 |
|------|------|------|
| `opencli stock init` | 无 | 获取 Cookie，自动安装插件 |
| `node init-db.js` | 无 | 初始化数据库表结构 |
| `node sync.js` | `[startDate] [endDate]` | 同步交易记录，日期格式 YYYYMMDD |
| `node match.js` | `[startDate] [endDate]` | 匹配买卖记录 |
| `node profit.js` | `[startMonth] [endMonth]` | 查询收益，月份格式 YYYY-MM |
| `node quotes.js` | `[account]` | 查询实时行情，account 可选 |

**关键特性**：
- sync：自动分页（max_page）、错误重试（3次）、幂等（INSERT OR REPLACE）
- profit：年收益 = 年初到查询截止月累计
- quotes：实时 API，无需提前同步

## 输出格式

| 命令 | 输出格式 |
|------|----------|
| profit | 表格：账户/时间/代码/名称/交易次数/总收益，末尾附月/年收益汇总 |
| quotes | 按账户分组，每组末尾附汇总行，按当日盈亏率降序 |
| sync | 成功：记录数+时间范围；失败：提示更新 Cookie |
| match | 成功：匹配数量；部分未匹配：提示原因 |

## 数据速查

| 项目 | 值 |
|------|---|
| 数据库 | `~/.duckdb/stock/stock.db` |
| 配置文件 | `~/.duckdb/stock/config`（存放 Cookie） |
| 脚本目录 | `~/Workspace/personal/stock-skill/scripts/` |
| 交易记录表 | `t_trade_record` |
| 匹配记录表 | `t_trade_matched_record` |
| op='1' | 买入 |
| op='2' | 卖出 |

**⚠️ 始终用 `op` 数字字段区分买卖，`op_name` 字段不可靠。**

## 故障排除

### 如果同步失败

**症状**：`node sync.js` 报错或返回空数据

**检查顺序**：
1. **Cookie 是否过期？** → 检查 `~/.duckdb/stock/config` 文件修改时间，超过 24 小时执行 `opencli stock init`
2. **网络是否正常？** → 执行 `curl -s https://tzzb.10jqka.com.cn` 测试连通性
3. **日期格式是否正确？** → 必须是 `YYYYMMDD`，如 `20260627`
4. **脚本目录是否正确？** → 必须在 `~/Workspace/personal/stock-skill/scripts/` 下执行
5. **是否 API 限流？** → 等待 30 秒后重试，脚本内置 3 次重试
6. **是否并发冲突？** → 检查是否有其他 sync 进程运行：`ps aux | grep sync.js`

**回退方案**：如果同步失败，数据不会丢失，可重新执行。

### 如果匹配失败

**症状**：`node match.js` 匹配数量为 0

**检查顺序**：
1. **是否已同步？** → 先执行 `node sync.js` 确保有数据
2. **时间范围是否匹配？** → match 的日期范围必须覆盖 sync 的日期范围
3. **数据库是否有数据？** → 执行 `~/.local/bin/duckdb ~/.duckdb/stock/stock.db -c "SELECT count(*) FROM t_trade_record;"`

### 如果收益查询失败

**症状**：`node profit.js` 返回空或报错

**检查顺序**：
1. **是否已匹配？** → 先执行 `node match.js`
2. **月份格式是否正确？** → 必须是 `YYYY-MM`，如 `2026-06`
3. **该月是否有数据？** → 检查 `t_trade_matched_record` 表是否有该月数据

### 如果行情获取失败

**症状**：`node quotes.js` 报错或返回空

**检查顺序**：
1. **Cookie 是否过期？** → 执行 `opencli stock init` 更新
2. **网络是否正常？** → 检查网络连接
3. **账户是否有持仓？** → 确认股票账户有持仓股票

### 如果数据库损坏

**症状**：各种 SQL 错误

**处理**：
1. 备份：`cp ~/.duckdb/stock/stock.db ~/.duckdb/stock/stock.db.bak`
2. 重新初始化：`node init-db.js`
3. 重新同步：`node sync.js 20250101 $(date +%Y%m%d)`
4. 重新匹配：`node match.js 20250101 $(date +%Y%m%d)`

## 注意事项

- GC001（204001）是国债逆回购，查询时排除
- 账户超 1000 条自动分页拉取（根据 API 返回的 max_page）
- 交易记录同步支持错误重试（默认 3 次）
- history_id 基于交易数据生成，确保幂等性

## 不要做什么（反例清单）

**🔴 STOP：** 以下操作可能导致数据丢失或功能异常，执行前必须确认。

### ❌ 禁止操作

| 错误操作 | 正确做法 | 原因 |
|----------|----------|------|
| 直接用 SQL 查询收益 | 使用 `node profit.js` | profit.js 有特殊的年收益计算逻辑 |
| 用 `op_name` 区分买卖 | 用 `op` 字段（'1'买入，'2'卖出） | op_name 字段不可靠 |
| 手动修改 history_id | 让脚本自动生成 | 破坏幂等性，导致重复数据 |
| 跳过 match 直接查收益 | 先 match 再 profit | 未匹配的记录不会计入收益 |
| 同步时不指定日期范围 | 指定具体日期范围 | 默认只同步当月，可能遗漏数据 |
| 删除 stock.db 重新 init | 先备份再操作 | 会丢失历史数据 |
| 使用 node v24 运行脚本 | 使用 node v20 或以下 | DuckDB 原生模块兼容性问题 |
| 在 scripts 目录外执行脚本 | 必须在 scripts 目录下执行 | 相对路径会找不到模块 |
| 直接修改 sql-sync.js 的 SQL | 使用 Node.js fetch 替代 | 已移除 http_request 扩展依赖 |
| 同步时使用未来日期 | 使用当前或历史日期 | API 会返回空数据 |
| 匹配时使用比同步更大的范围 | 匹配范围应 ≤ 同步范围 | 会匹配到不存在的数据 |
| 重复运行 init-db.js | 只在首次或损坏时运行 | 会清空已有数据 |
| 网络超时时立即重试 | 等待 30 秒后重试 | 避免触发 API 限流 |
| 同步时使用通配符日期 | 使用具体日期范围 | 避免同步过多数据 |
| 在匹配完成前查询收益 | 先完成匹配再查询 | 未匹配数据不计入收益 |
| 忽略错误重试次数 | 检查重试日志 | 可能是持久性错误 |
| 同时运行多个 sync 进程 | 单线程执行 | 避免数据库并发冲突 |
| 网络超时时立即重试 | 等待 30 秒后重试 | 避免触发 API 限流 |
| 同步时使用通配符日期 | 使用具体日期范围 | 避免同步过多数据 |
| 在匹配完成前查询收益 | 先完成匹配再查询 | 未匹配数据不计入收益 |
| 忽略错误重试次数 | 检查重试日志 | 可能是持久性错误 |
| 同时运行多个 sync 进程 | 单线程执行 | 避免数据库并发冲突 |

### ⚠️ 危险动作

| 动作 | 风险 | 防护 |
|------|------|------|
| 大范围同步（>3个月） | 耗时长、可能超时 | 先确认用户意图，分批执行 |
| 并发修改数据库 | 数据损坏 | 使用单例连接，避免并发写入 |
| Cookie 明文存储 | 安全风险 | 仅本地使用，不上传 |

### 🔴 红灯行为（STOP）

**以下操作严格禁止，违反可能导致数据损坏：**

- **不要**在未同步的情况下查询收益 → 先执行 `node sync.js`
- **不要**在未匹配的情况下统计收益 → 先执行 `node match.js`
- **不要**手动 INSERT 数据库 → 必须使用脚本
- **不要**修改 SQL 表结构 → 除非明确需要且已备份
- **不要**在生产环境测试新功能 → 先在测试环境验证
- **不要**并发修改数据库 → 使用单例连接
