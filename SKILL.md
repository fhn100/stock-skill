---
name: stock-skill
description: "股票交易数据管理：同步交易记录、匹配买卖、统计网格收益、排查未匹配记录。触发词：收益、网格收益、赚了多少、同步、匹配、未匹配、重跑、profit、stock"
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
| 交易记录同步 | `opencli stock sync [start] [end]` | 建表 + 同步账户字典 + 拉取交易记录，日期格式 `YYYYMMDD`（默认当月）；自动分页、幂等 |
| 仅初始化表结构 | `opencli stock init-db` | 只建表建索引（sync 启动时已自动执行） |
| 交易记录匹配 | `node match.js` | 匹配本地库中未配对的买入/卖出（纯本地，不联网） |
| 收益统计 | `node profit.js [startMonth] [endMonth]` | 查询网格收益，月份格式 `YYYY-MM`；年收益 = 年初至截止月累计。执行时先清理**查询范围内** 0 过户费的匹配记录，再调用与 `match.js` 相同的 `tradeMatch()`（对全库未匹配记录重算配对，不止查询范围）；0 过户费的交易记录只统计提示，需 `opencli stock sync` 重拉修复；纯本地，不联网 |
| 未匹配查询 | `node unmatched.js [--code] [--name] [--op] [--start] [--end] [--account] [--all]` | 默认只列可配对记录（op=1/2 且数量>0），与 `match.js` 口径一致；`--all` 含逆回购/派息等非买卖流水 |
| 纯函数自测 | `node --test selftest.js` | 校验匹配算法、净额口径、日期与表格工具（不碰数据库） |

**📋 触发词与动作映射**：首次使用/init → 初始化流程；同步、拉取交易 → `opencli stock sync`；匹配、配对 → `match.js`；收益、赚了多少、网格收益 → `profit.js`；未匹配、为什么没配上 → `unmatched.js`；重跑、重新匹配 → `node match.js`。

**本技能已不联网**：`scripts/` 下的脚本全部只读写本地 DuckDB；实时行情与账户收益卡片能力已下线，联网只有 `opencli stock sync` 一条路径。

**⚠️ 不提供删除能力**：本技能没有删除交易/匹配记录的工具，也禁止手写 SQL DELETE。数据修正一律通过幂等的 `opencli stock sync` / `node match.js` 重跑覆盖完成（`profit.js` 只删除查询范围内 0 过户费的匹配记录并立即重配，不删交易记录）。

**📐 收益口径**：网格收益 = 现货买卖的净额价差之和（买入净成本含佣金过户费，卖出净所得扣费），**不含**国债逆回购收益（op=5/35）、现金分红（op=6）、缴税/转入转出等非买卖流水。与券商账户的总收益对账时会有差额，属预期口径而非丢数据。

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
# 执行前询问："Cookie 已获取，确认初始化数据库并同步当月数据？"

# 3. 建表 + 同步账户与当月交易记录
opencli stock sync
```

### 场景：查看收益（最常用）

```bash
# 步骤1：同步最新数据（用户说"同步"或"最新"时执行；纯查询收益可跳过）
opencli stock sync

# 步骤2~3：本地匹配 + 统计（在脚本目录下执行）
cd ~/.agents/skills/stock-skill/scripts
node match.js
node profit.js [YYYY-MM] [YYYY-MM]
```

**执行规则**：
- 用户说"这个月收益" → 直接执行 `node profit.js`
- 用户说"同步并查看收益" / "最新收益" → 按顺序执行 sync → match → profit
- **结果必须以 Markdown 表格输出给用户**（收益等统计结果均适用），格式见下方「输出格式」

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

### 场景：重跑某月配对（不删数据）

配对结果不对或想纳入新对手盘时，**不删数据**，直接重跑匹配（对全库未配对记录重算，无需日期参数）：

```bash
cd ~/.agents/skills/stock-skill/scripts
node match.js
node profit.js 2026-09
```

注意：`opencli stock sync` 采用 INSERT OR REPLACE 幂等写入，同窗口重跑即交易数据修正的唯一手段。

### 场景：同步历史数据

```bash
# 🔴 STOP · 检查点：同步前必须确认时间范围
# 执行前询问："确认同步 XXXX-XX-XX 至 XXXX-XX-XX 的数据？"

opencli stock sync 20250101 20260627

# 🔴 STOP · 检查点：匹配前确认同步完成
cd ~/.agents/skills/stock-skill/scripts && node match.js
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
| sync | `opencli stock sync`：成功：记录数+时间范围；失败：提示更新 Cookie |
| match | 成功：匹配数量；部分未匹配：提示原因 |

## 数据速查

| 项目 | 值 |
|------|---|
| 交易记录表 | `t_trade_record` |
| 匹配记录表 | `t_trade_matched_record` |
| 数据库索引 | `idx_trade_op_date`(op,entry_date), `idx_trade_code`, `idx_matched_sell_history`, `idx_matched_sell_time` 等 |
| op 码 | `1`=买入、`2`=卖出（仅此两者参与配对）；`5`/`35`=逆回购买卖（代码 131810 R-001、204001 GC001）、`6`=派息、`95`=缴税、`18`/`86`=转入、`19`/`87`=转出、`222`=入账、`235`/`236`=0 成本入账类买卖（⚠️ 始终用 `op` 数字字段，`op_name` 不可靠） |
| 配对范围 | 仅同账户 + 同代码 + 同成交数量可互配，不做数量拆分；逆回购/派息等不参与配对 |

## 注意事项

- 账户超 1000 条自动分页拉取（根据 API 返回的 max_page）
- history_id 基于交易数据生成，确保幂等性
- 不支持手动删记录：无删除工具且禁止手写 SQL DELETE，修正数据靠幂等重跑 sync/match

## 🔴 红线速查

- **不要**手写 SQL DELETE / 手动 INSERT 修改数据（无删除工具，修正数据靠幂等重跑 sync/match）
- **不要**跳过 match 直接查收益（未匹配记录不计入收益）
- **不要**同时运行多个 sync/match 进程（DuckDB 单写者锁会静默丢写入）

完整禁例清单与危险动作见 [references/anti-patterns.md](references/anti-patterns.md)；同步/匹配/收益故障排查见 [references/troubleshooting.md](references/troubleshooting.md)。
