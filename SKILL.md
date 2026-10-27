---
name: stock-skill
description: "股票交易数据管理：同步 A 股与嘉信美股交易记录、匹配买卖、统计网格收益、排查未匹配记录。触发词：收益、网格收益、赚了多少、同步、嘉信、美股、匹配、未匹配、重跑、profit、stock"
category: finance
---

# 股票交易技能

基于 `opencli stock` 插件复用浏览器登录态同步交易数据，本地用 DuckDB 做匹配与收益统计。

## 环境

- **脚本目录**：`~/.agents/skills/stock-skill/scripts/`（所有命令必须在此目录下执行）
- **数据库**：`~/.duckdb/stock/stock.db`（唯一落盘数据）
- **嘉信登录配置**：`~/.duckdb/stock/stock.config`（`SCHWAB_USERNAME` / `SCHWAB_PASSWORD` / `SCHWAB_SECRET`，仅 `opencli stock login` 读取；建议 `chmod 600`）。接口调用一律在浏览器上下文内发起，**Bearer token 与 Cookie 不落盘**
- **Node 版本**：node v24 可正常运行（2026-09 验证）；若遇 DuckDB 原生模块加载错误，先 `npm rebuild`，仍失败再降级 node v20，详见 [README.md 故障排除](README.md#故障排除)

## 命令总览

| 功能 | 命令 | 说明 |
|------|------|------|
| 交易记录同步 | `opencli stock sync [start] [end]` | **只管同花顺（A 股/港股）**，美股走下面的 `sync-schwab`。复用浏览器登录态（策略 COOKIE）拉取数据；需先在浏览器登录 `https://tzzb.10jqka.com.cn/pc/index.html`。建表 + 同步账户字典 + 交易记录，日期格式 `YYYYMMDD`（默认当月）；自动分页、幂等 |
| 嘉信美股接口同步 | `opencli stock sync-schwab [start] [end] [--account 嘉信-冯] [--account-id 10301685] [--dry-run]` | **美股数据唯一写入路径**（独立命令，`sync` 不再接受任何嘉信参数）。走 `ausgateway.schwab.com` 交易接口拉嘉信(Schwab)成交并写 `t_trade_record`；**须先 `opencli stock login`**。不给日期=全量（接口 `timeFrame=All`，本地按区间过滤）；`history_id` 沿用库中既有美股记录的同一公式（`CSV\|` 前缀是历史命名，CSV 导入脚本已移除），重跑覆盖不重复 |
| 仅初始化表结构 | `opencli stock init-db` | 只建表建索引（sync 启动时已自动执行） |
| 交易记录匹配 | `node match.js [--strategy lifo\|fifo\|psf\|all]` | 匹配本地库中未配对的买入/卖出（纯本地，不联网）。默认 `all`=三种算法都跑；`lifo`=后入先出（成交配对视图）；`fifo`=先入先出（盈亏计算视图）；`psf`=价差最小优先（不限时间）。匹配结果写入 `match_type` 字段区分 |
| 收益统计 | `node profit.js [startMonth] [endMonth] [--strategy lifo\|fifo\|psf]` | 查询网格收益，月份格式 `YYYY-MM`；年收益 = 年初至截止月累计。执行时在一个事务内先清理**查询范围内** 0 过户费的匹配记录、再调用与 `match.js` 相同的 `tradeMatch()` 重算配对（崩溃则整体回滚，不会留下"删了未重配"的不一致）；匹配策略同 `match.js`，默认 `lifo`。0 过户费的交易记录只统计提示，需 `opencli stock sync` 重拉修复。输出含**币种列**（嘉信等 `market_code='US'` 账户标 USD，其余 CNY，跨账户不可加总）；纯本地，不联网 |
| 未匹配查询 | `node unmatched.js [--code] [--name] [--op] [--start] [--end] [--account] [--all]` | 默认只列可配对记录（op=1/2 且数量>0），与 `match.js` 口径一致；`--all` 含逆回购/派息等非买卖流水 |
| 纯函数自测 | `node --test selftest.js` | 校验匹配算法、净额口径、嘉信同步纯函数与 `history_id` 主键守卫、日期与表格工具、schema 漂移守卫（不碰数据库） |
| 钱路集成测试 | `node --test inttest.js` | 临时 DuckDB 库跑通 `tradeMatch` 落库 + `gridProfit` 聚合，校验收益金额、币种与 SQL 参数绑定 |

**📋 触发词与动作映射**：首次使用/初始化 → 首次使用流程（插件就位 + 浏览器登录 + sync）；同步、拉取交易 → `opencli stock sync`；嘉信登录 → `opencli stock login`；嘉信接口同步、Schwab 同步、美股、CSV（用户手上只有导出文件时也走接口） → `opencli stock sync-schwab`；匹配、配对 → `match.js`；收益、赚了多少、网格收益 → `profit.js`；未匹配、为什么没配上 → `unmatched.js`；重跑、重新匹配 → `node match.js`。

**联网面**：`scripts/` 下的脚本全部只读写本地 DuckDB，不联网；实时行情与账户收益卡片能力已下线。联网只剩 `opencli stock sync`（同花顺）、`opencli stock sync-schwab`（嘉信）与 `opencli stock login` 三条路径，且都在浏览器会话内发起。

**⚠️ 不提供删除能力**：本技能没有删除交易/匹配记录的工具，也禁止手写 SQL DELETE。数据修正一律通过幂等的 `opencli stock sync` / `node match.js` 重跑覆盖完成（`profit.js` 只删除查询范围内 0 过户费的匹配记录并立即重配，不删交易记录）。

**📐 收益口径**：网格收益 = 现货买卖的净额价差之和（买入净成本含佣金过户费，卖出净所得扣费），**不含**国债逆回购收益（op=5/35）、现金分红（op=6）、缴税/转入转出等非买卖流水。与券商账户的总收益对账时会有差额，属预期口径而非丢数据。

## 标准工作流

### 场景：首次使用

```bash
# 🔴 STOP · 检查点：首次使用前确认环境
# 执行前询问："首次使用需要初始化并同步当月数据，确认继续？"

# 1. 确认 opencli stock 插件已就位（未就位则复制仓库 resources/stock 到插件目录）
ls ~/.opencli/plugins/stock/sync.js || cp -r ~/.agents/skills/stock-skill/resources/stock ~/.opencli/plugins/stock

# 2. 确认浏览器已登录同花顺投资决策页（sync 复用该登录态，本地不落凭证）
#    未登录时先在浏览器打开并登录 https://tzzb.10jqka.com.cn/pc/index.html

# 3. 建表 + 同步账户与当月交易记录
opencli stock sync
```

### 场景：查看收益（最常用）

```bash
# 步骤1：同步最新数据（用户说"同步"或"最新"时执行；纯查询收益可跳过）
opencli stock sync

# 步骤2：统计（在脚本目录下执行；profit 内部已自动匹配，无需先跑 match.js）
cd ~/.agents/skills/stock-skill/scripts
node profit.js [YYYY-MM] [YYYY-MM]
```

**执行规则**：
- 用户说"这个月收益" → 直接执行 `node profit.js`（profit 会先对全库未匹配记录重算配对再统计，不必前置 `match.js`）
- 用户说"同步并查看收益" / "最新收益" → 按顺序执行 sync → profit
- 仅想重算配对而不看收益时才单独跑 `node match.js`
- **结果必须以 Markdown 表格输出给用户**（收益等统计结果均适用），格式见下方「输出格式」

**边界处理：**
- 登录态失效：同花顺 `sync` 报 `AuthRequiredError` / HTTP 401/403 时，提示在浏览器重新登录 `https://tzzb.10jqka.com.cn/pc/index.html` 后重试（无本地 Cookie 文件可更新）；嘉信 `sync-schwab` 报 `AUTH_REQUIRED`（含「未捕获到 Bearer token」）时，重跑 `opencli stock login` 后重试
- 网络异常：提示检查网络连接后重试
- 无数据：提示是否需要同步历史数据

**输出示例**（仅含盈利配对，无负数；以 Markdown 表格输出给用户）：

```markdown
## 📊 收益统计结果（2026-07）

| 账户 | 币种 | 代码 | 名称 | 交易次数 | 收益 |
|------|:---:|------|------|:---:|---:|
| 国泰-冯* | CNY | 02269 | 药明生物 | 5 | 5,020.87 |
| 国泰-冯* | CNY | 512400 | 有色金属ETF南方 | 6 | 403.26 |
| 嘉信-冯* | USD | TSLA | TESLA INC | 19 | 166.10 |

| 账户 | 币种 | 月收益（2026-07） | 年收益（累计） |
|------|:---:|---:|---:|
| 国泰-冯* | CNY | **6,654.73** | 75,942.36 |
| 嘉信-冯* | USD | **166.10** | 1,048.65 |
```

> 币种由 `market_code` 派生（`US`→USD，其余→CNY）；同账户天然单币种，**跨币种不可加总**。

### 场景：重跑某月配对（不删数据）

配对结果不对或想纳入新对手盘时，**不删数据**，直接重跑收益统计（`profit.js` 会对全库未配对记录重算，无需单独 match）：

```bash
cd ~/.agents/skills/stock-skill/scripts
node profit.js 2026-09
```

只想重算配对、不出收益表时，才单独跑 `node match.js`。

注意：`opencli stock sync` 与 `sync-schwab` 都采用 INSERT OR REPLACE 幂等写入，同主键重跑是交易数据修正的唯一手段。

### 场景：同步历史数据

```bash
# 🔴 STOP · 检查点：同步前必须确认时间范围
# 执行前询问："确认同步 XXXX-XX-XX 至 XXXX-XX-XX 的数据？"

opencli stock sync 20250101 20260627

# 🔴 STOP · 检查点：匹配前确认同步完成
cd ~/.agents/skills/stock-skill/scripts && node match.js
```

**🔴 STOP · 检查点：** 大范围同步（超过 3 个月）前必须确认用户意图，避免长时间等待。

### 场景：同步嘉信(Schwab)美股（美股数据唯一入口）

```bash
# 步骤1：登录嘉信（凭据/TOTP 密钥读 ~/.duckdb/stock/stock.config，浏览器会话持久化）
opencli stock login

# 步骤2：先 dry-run 看解析量，确认无误再写库（只读，不动真实数据）
opencli stock sync-schwab 20261001 20261031 --dry-run

# 步骤3：正式同步。不给日期 = 全量（约 2 页/4 年，实测接口 294 条 → 拆股后 323 条入库）
opencli stock sync-schwab

# 步骤4：配对 + 收益（美股与 A 股同一套）
cd ~/.agents/skills/stock-skill/scripts && node profit.js
```

**接口同步语义（勿改，改了会重复计收益）：**
- **鉴权复用浏览器会话**：先打开 `client.schwab.com/app/accounts/summary`，从浏览器发出的 `ausgateway.schwab.com` 请求头里取 `Bearer` token，再把标签页导航到 ausgateway 源页面**同源**调用交易接口（跨源 fetch 会被 CORS 拦掉）。token 只在本次进程内存中使用，**本地不落任何凭证**；报 `AUTH_REQUIRED` 就重跑 `opencli stock login`。
- **`history_id` 主键口径（2026-10-27 起）**：美股买卖按 1 股拆分后，每条以 `schwabOrderId_序号` 为主键（如 `1007298688974_1` / `_2` / `_3`，序号从 1 起）；qty=1 的记录不加后缀，仍是裸 `schwabOrderId`。`schwabOrderId` 为 0/缺失的记录（嘉信老交易、Margin/Credit Interest、MoneyLink Transfer 等）回退到 `sha1("CSV|账户|时间|代码|方向|数量|价格").hex` 前 24 位作基础键，拆分时同样追加 `_序号`。**基础键公式都不可改**：换主键口径 = 同一批记录生成新键、与旧行并存、收益翻倍，而本技能没有删除能力，只能手工清库挽救。`selftest.js` 用哈希金值（`c89fb934437da3f7da870c4a`）守住回退公式这条线。库里美股记录已按此口径重写（备份 `stock.db.bak-20261027-pre-us-cleanup` / `-pre-orderid` / `-pre-issueid-fix` / `-pre-split`）。
  - **不要用 `itemIssueId` 当主键**（2026-10-27 实测否决）：它跟证券绑定而非逐笔订单，同一只 TSLA 的所有成交共用 `1948561409`，当主键会让同股全部成交挤在一个 base 键上、靠顺序分配 `x02` 区分，新增成交即整体错位覆盖。`selftest.js` 有一条守卫用例钉住这个结论。
  - MoneyLink Transfer 等流水日期带后缀（`"10/03/2025 as of 10/02/2025"`），`parseSchwabDate` 取前段交易日；这类流水无订单号，走哈希回退。
  - **接口的 `schwabOrderId` 偶发时有时无**（实测 2026-10-27：2026-02-10 一笔 TSLA 卖出 1 股 @425 在多次拉取间 `1005383223451` / `"0"` 交替）。`sync-schwab` 写入前按内容签名（时间+代码+方向+数量+价格+金额）去重：同签名下若库里只有另一种键，跳过本次写入；同一种键的重复内容照常保留（同日同价的多笔独立委托）。不这样做重跑会为同一笔生成订单号键 + 哈希键两条、收益翻倍。
- **买卖成交按 1 股拆分入库**：接口一条 qty=N → 库里 N 条 `entry_count=1`，`entry_money/entry_cost/commission/fee_total` 按股均摊（除不尽的尾差落在最后一条，拆分前后合计不变），`entry_price` 保持每股成交价。配对脚本按 1 股粒度匹配，整笔 qty>1 会配不上。现金流水（op=6/18/19/99，含 MoneyLink Transfer，无 `symbol` 时 code 记空串）不拆、不参与买卖配对。同主键重复（现金流水可能同日同参数）追加 `x02` 序号防冲突；拆股键的去重标记追加在 `_序号` 之后（`123_1x02`），不截断后缀。
- **金额口径（已定）**：`entry_money` 取接口 `amount`——它**已是扣费后的净额**（卖出实收、买入实付）；`commission/fee_total` 记接口 `feesAndCommission`（用户拍板的口径）。已知并接受：`netMoneyOf` 会在净额基础上再减一次 `commission`，美股卖单合计约 0.65 的重复扣费，属口径内误差。
- 接口响应**没有任何成交时间**，统一记 `entry_time='16:00:00'`（美股收盘近似），保证同日顺序确定、跨机器 `history_id` 稳定。
- 接口日期参数只验证过 `timeFrame=All`（`Last30Days` 等取值会 400），所以时间区间一律**本地过滤**；降序返回，一旦早于 `--start` 即停止翻页。
- `--account` 必须与既有数据一致（默认 `嘉信-冯`）：`account_id` 由账户名派生（`US-<sha1 前 10 位>` = `US-c0e4a175de`），改名等于换一个账户，会与历史数据并存成两套。

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
| profit | 脚本原始输出为纯文本表格；**回复用户时必须转为 Markdown 表格**：个股明细表（账户/币种/代码/名称/交易次数/收益）+ 汇总表（账户/币种/月收益/年收益），金额千分位格式化；务必带币种列，提醒跨币种不可加总 |
| sync | `opencli stock sync`：成功：记录数+时间范围；失败：区分登录态失效（同花顺提示浏览器重新登录）与风控限流（降低频率重试） |
| sync-schwab | 成功：页数+拉取条数+写入条数（`--dry-run` 只报解析条数、不写库）；失败：登录态失效提示重跑 `opencli stock login` |
| match | 成功：匹配数量；部分未匹配：提示原因 |

## 数据速查

| 项目 | 值 |
|------|---|
| 交易记录表 | `t_trade_record` |
| 匹配记录表 | `t_trade_matched_record`（含 `match_type` 字段：lifo/fifo/psf） |
| 数据库索引 | `idx_trade_op_date`(op,entry_date), `idx_trade_code`, `idx_matched_sell_history`, `idx_matched_sell_time` 等 |
| op 码 | `1`=买入、`2`=卖出（仅此两者参与配对）；`5`/`35`=逆回购买卖（代码 131810 R-001、204001 GC001）、`6`=派息、`95`=缴税、`18`/`86`=转入、`19`/`87`=转出、`222`=入账、`235`/`236`=0 成本入账类买卖（⚠️ 始终用 `op` 数字字段，`op_name` 不可靠） |
| 配对范围 | 仅同账户 + 同代码 + 同成交数量可互配，不做数量拆分；逆回购/派息等不参与配对 |
| 匹配策略（默认 lifo） | **后入先出（LIFO，最短持有优先）**：用于成交配对视图，帮助用户直观查看网格交易的实际配对情况，评估网格运行的健康度。卖出按时间升序处理，可用买入 = 未匹配且 time ≤ 卖出时间的买入；每次取时间最新且盈利的买入配对 |
| 匹配策略（fifo） | **先入先出（FIFO，最长持有优先）**：用于盈亏计算视图，基于先入先出原则为客户提供网格逐笔盈亏计算服务。撇除股票持仓的自然盈亏，仅统计网格增益部分。卖出按时间升序处理，可用买入 = 未匹配且 time ≤ 卖出时间的买入；每次取时间最早且盈利的买入配对 |
| 匹配策略（psf） | **价差最小优先（PSF，Price Smallest First）**：不限买卖时间顺序，卖出价必须高于买入价，取价差最小的配对；每条记录只能匹配一次。配对数最多但可能包含跨期配对 |

## 注意事项

- 账户超 1000 条自动分页拉取（根据 API 返回的 max_page）
- history_id 基于交易数据生成，确保幂等性
- 不支持手动删记录：无删除工具且禁止手写 SQL DELETE，修正数据靠幂等重跑 sync/match

## 🔴 红线速查

- **不要**手写 SQL DELETE / 手动 INSERT 修改数据；美股与 A 股数据修正一律靠幂等重跑 `opencli stock sync` / `sync-schwab`（同主键 INSERT OR REPLACE 覆盖）。注意 CSV 导入脚本连同其 `--replace` 整表重导一起移除后，**已没有按账户清除美股数据的工具**：改账户名或改动 `history_id` 公式会让新旧两套并存，只能备份数据库后手工清库挽救
- **不要**给嘉信换 `--account` 名称：`account_id` 由账户名派生（`US-<sha1 前 10 位>`），改名会让新旧两套记录并存、收益翻倍；同一账户名重跑 `sync-schwab` 才是覆盖而非新增
- **不要**直接查匹配表当收益：未匹配记录不计入收益；`profit.js` 已在查询前自动重算配对，无需单独跑 `match.js`
- **不要**同时运行多个 sync/profit/match 进程（DuckDB 单写者锁会静默丢写入）；`opencli stock sync-schwab` 与 `opencli stock login` 也共用同一个浏览器会话，串行执行

故障排查见 [README.md 故障排除](README.md#故障排除)；命令清单与口径以本文件「命令总览」「收益口径」「红线速查」为准。
