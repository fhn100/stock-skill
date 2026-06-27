---
name: stock-skill
description: "股票交易数据管理技能，支持初始化、数据同步、交易匹配、收益统计和实时行情查询。使用场景：查看网格交易收益、同步交易数据、匹配买卖记录、获取持仓实时行情。触发词：股票收益、网格收益、交易统计、stock profit、同步交易、交易匹配、实时行情、持仓行情、股票行情"
category: finance
---

# 股票交易技能

基于 `opencli stock` 命令行工具管理股票交易数据。插件目录：`~/.opencli/plugins/stock`

## 触发词与动作映射

| 用户意图 | 触发词 | 执行动作 |
|---------|--------|---------|
| 查看收益 | 收益、赚了多少、profit、网格收益 | `opencli stock profit [范围]` |
| 同步数据 | 同步、拉取交易、更新数据 | `opencli stock sync [起止日期]` |
| 匹配记录 | 匹配、配对、买卖匹配 | `opencli stock match` |
| 首次使用 | 初始化、init | `opencli stock init` |
| 查某只股票 | "XX股票赚了多少" | 先 profit，再从输出中筛选 |
| 实时行情 | 行情、实时行情、持仓行情、股票行情、最新价 | `opencli stock quotes [账户]` |
| 持仓查询 | 持仓、现在持有、手里有什么股票 | `opencli stock quotes` |

## 标准工作流

### 场景：查看收益（最常用）

用户问收益相关问题时，按顺序执行：

```bash
# 1. 同步最新数据（可选，如用户要求"最新"）
opencli stock sync

# 2. 匹配交易记录（确保数据完整）
opencli stock match

# 3. 统计收益（核心步骤）
opencli stock profit [YYYY-MM] [YYYY-MM]
```

**注意：** 如果用户只是问"这个月收益"，直接执行 `opencli stock profit` 即可，不需要每次都 sync+match。只有用户明确要求"同步"或"最新数据"时才执行前两步。

**边界处理：**
- Cookie 过期：同步失败时提示更新配置文件
- 网络异常：提示检查网络连接后重试
- 无数据：提示是否需要同步历史数据

### 场景：查看某只股票收益

```bash
opencli stock profit 2026-04
# 从输出中找到对应股票行，展示其交易次数和收益
```

### 场景：查看持仓实时行情（最常用）

用户问持仓、行情、最新价相关问题时，执行：

```bash
# 获取所有账户持仓行情
opencli stock quotes

# 获取指定账户行情
opencli stock quotes 冯
```

**注意：** 此命令会实时调用 API 获取最新行情数据，无需提前同步。

**边界处理：**
- Cookie 过期：提示更新配置文件
- 网络异常：提示检查网络连接
- 账户无持仓：提示确认账户是否有持仓股票

### 场景：查询交易记录 / 匹配记录（DuckDB MCP）

**优先使用 DuckDB MCP 工具直接查询**，不要写 node 脚本。

**MCP工具调用方式：**
```
mcp_mcp_server_duckdb_query(query="SQL语句")
```

查询个股交易记录：

```sql
SELECT account_name, name, code, op, entry_price, entry_count, entry_money, entry_date, entry_time
FROM t_trade_record
WHERE name LIKE '%股票名%'
ORDER BY entry_date DESC, entry_time DESC
LIMIT 20
```

查询匹配记录：

```sql
SELECT account_name, name, code, buy_price, buy_count, sell_price, sell_count, profit, buy_date, sell_date
FROM t_trade_matched_record
WHERE name LIKE '%股票名%'
ORDER BY sell_date DESC
LIMIT 20
```

查询今日交易：

```sql
SELECT entry_date, entry_time, code, name, op, entry_price, entry_count, entry_money
FROM t_trade_record
WHERE entry_date = current_date
ORDER BY entry_time
```

**注意：** op='1' 买入，op='2' 卖出。始终用 `op` 字段，不要用 `op_name`。

## 命令参考

### `opencli stock init`
首次使用执行，初始化数据库和配置。只需运行一次。

### `opencli stock sync [startDate] [endDate]`
- 日期格式：`YYYYMMDD`，不传默认同步当月
- **大范围同步耗时长，建议按季度分批**
- 使用 `INSERT OR REPLACE`，重复同步不会产生重复数据

**⚠️ 检查点：** 大范围同步（超过 3 个月）前需确认用户意图，避免长时间等待。

### `opencli stock match`
将买入/卖出记录按 `account_id + code + entry_count` 配对。一次调用循环匹配直到完成。

### `opencli stock profit [start] [end]`
- 月份格式 `YYYY-MM`，不传默认当月
- **必须用此命令统计收益，不要直接 SQL 查询**
- 年收益 = 年初到查询截止月的累计（非全年）

### `opencli stock quotes [account]`
- 获取持仓股票的实时行情数据
- `account` 参数可选，用于过滤账户名称（支持模糊匹配）
- 实时调用 API，无需提前同步
- 输出包含：当日盈亏、持有数量、持有金额、最新价、持有盈亏等

**使用示例：**
```bash
# 获取所有账户持仓行情
opencli stock quotes

# 获取指定账户行情（模糊匹配）
opencli stock quotes 冯
opencli stock quotes 陈
```

**输出字段说明：**
- 账户名称：脱敏显示（保留姓，名替换为*）
- 代码：股票代码
- 名称：股票名称
- 当日盈亏：今日盈亏金额
- 当日盈亏率：今日盈亏百分比
- 持有数量：当前持有股数
- 持有金额：当前持有市值
- 最新价：当前市场价格
- 持有盈亏：累计盈亏金额
- 持有盈亏率：累计盈亏百分比
- 汇总：账户持仓汇总信息

## 输出格式规范

### profit 输出

- 精简表格，按总收益降序排列
- 末尾附**月收益**和**年收益**汇总行（加粗）
- 严格按命令返回内容展示，不自行补充数据
- 收益为正显示绿色/正值，为负显示红色/负值

### quotes 输出

- 按账户分组展示持仓行情
- 每个账户末尾附**汇总**行
- 按当日盈亏率降序排列
- 实时数据，无需提前同步

### sync 输出
- 成功：告知同步的记录数和时间范围
- 失败：提示 Cookie 是否过期，引导更新配置文件

### match 输出
- 成功：告知匹配成功数量
- 部分未匹配：提示未匹配数量，说明原因（数量不等或原始持仓）

## 数据速查

| 项目 | 值 |
|------|---|
| 数据库 | `~/.opencli/plugins/stock/data/stock.db` |
| 配置文件 | `~/.opencli/plugins/stock/data/config`（存放 Cookie） |
| 交易记录表 | `t_trade_record` |
| 匹配记录表 | `t_trade_matched_record` |
| op='1' | 买入 |
| op='2' | 卖出 |
| 查询方式 | **DuckDB MCP 优先**，收益统计用 `opencli stock profit` |

**⚠️ 始终用 `op` 数字字段区分买卖，`op_name` 字段不可靠。**

## 故障排除

| 症状 | 原因 | 处理 |
|------|------|------|
| 同步失败 | Cookie 过期 | 更新 `~/.opencli/plugins/stock/data/config` 中的 cookie |
| 无收益数据 | 未匹配 | 执行 `opencli stock match` |
| 收益异常 | 未匹配记录 | 检查是否有未匹配的卖出（数量不等或原始持仓） |
| DB 错误 | 表结构变更 | 执行 `opencli stock init` 重新初始化 |
| 行情获取失败 | Cookie 过期 | 更新配置文件中的 cookie |
| 行情获取失败 | 网络问题 | 检查网络连接 |
| 行情获取失败 | 账户无持仓 | 确认账户是否有持仓股票 |

## 注意事项

- GC001（204001）是国债逆回购，查询时排除
- 账户超 1000 条自动分页拉取
- `grid.db` 存在但表为空，勿用