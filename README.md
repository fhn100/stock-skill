# 股票交易技能 (stock-skill)

基于 `opencli stock` 插件获取 Cookie，使用 Node.js 脚本管理股票交易数据。

## 功能

- 🍪 **Cookie 获取**：通过浏览器自动获取 Cookie
- 📊 **数据同步**：自动分页同步交易记录
- 🔗 **交易匹配**：自动匹配买卖记录（时间差最小优先，仅盈利配对）
- 💰 **收益统计**：查询网格收益
- 📈 **实时行情**：获取持仓实时行情

## 安装

### 前置条件

1. **Node.js** v20+（v24 已验证可用，2026-09）
2. **opencli** CLI 工具

### 安装 nvm 和 Node.js

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重新加载 shell 配置
source ~/.bashrc  # 或 source ~/.zshrc

# 安装 Node.js LTS 版本
nvm install --lts

# 使用 LTS 版本
nvm use --lts

# 验证安装
node --version  # 应显示 LTS 版本号
npm --version
```

### 安装 opencli

```bash
# 使用 npm 安装
npm install -g @jackwener/opencli

# 或使用 bun 安装
bun install -g @jackwener/opencli
```

### 安装 stock 插件

```bash
# 克隆仓库
git clone https://github.com/fhn100/stock-skill.git ~/.agents/skills/stock-skill

# 复制插件到 opencli 插件目录
cp -r ~/.agents/skills/stock-skill/resources/stock ~/.opencli/plugins/stock

# 安装插件依赖
cd ~/.opencli/plugins/stock && npm install
```

### 安装脚本依赖

```bash
cd ~/.agents/skills/stock-skill/scripts && npm install
```

## 快速开始

### 首次使用

```bash
# 1. 获取 Cookie（需要浏览器）
opencli stock init

# 2. 初始化数据库
cd ~/.agents/skills/stock-skill/scripts && node init-db.js

# 3. 同步交易记录
node sync.js 20250101 20260627

# 4. 匹配交易记录
node match.js 20250101 20260627

# 5. 查看收益
node profit.js
```

### 日常使用

```bash
cd ~/.agents/skills/stock-skill/scripts

# 同步当月数据
node sync.js

# 匹配交易记录
node match.js

# 查看本月收益（自动清理 0 过户费脏数据并修复）
node profit.js

# 查看实时行情
node quotes.js
```

## 命令参考

| 命令 | 参数 | 说明 |
|------|------|------|
| `opencli stock init` | 无 | 获取 Cookie，自动安装插件 |
| `node init-db.js` | 无 | 初始化数据库表结构 |
| `node sync.js` | `[startDate] [endDate]` | 同步交易记录，日期格式 YYYYMMDD |
| `node match.js` | `[startDate] [endDate]` | 匹配买卖记录 |
| `node profit.js` | `[startMonth] [endMonth]` | 查询收益，月份格式 `YYYY-MM`；自动清理 0 过户费脏数据：匹配记录按查询月份范围清理重配，交易记录仅当月清理重拉 |
| `node quotes.js` | `[account]` | 查询实时行情，account 可选 |
| `node account-profit.js` | `[account] [--json]` | 查询账户收益卡片，--json 输出 JSON |
| `node unmatched.js` | `[--code] [--name] [--op] [--start] [--end] [--account]` | 查询未匹配交易记录 |

## 数据存储

| 项目 | 路径 |
|------|------|
| 数据库 | `~/.duckdb/stock/stock.db` |
| 配置文件 | `~/.duckdb/stock/config` |
| 脚本目录 | `~/.agents/skills/stock-skill/scripts/` |

## 数据库表结构

### t_trade_record（交易记录表）

| 字段 | 类型 | 说明 |
|------|------|------|
| history_id | VARCHAR | 主键，基于交易数据生成 |
| account_id | VARCHAR | 账户 ID |
| account_name | VARCHAR | 账户名称 |
| code | VARCHAR | 股票代码 |
| name | VARCHAR | 股票名称 |
| op | VARCHAR | 操作类型（'1'买入，'2'卖出） |
| entry_price | DECIMAL | 成交价格 |
| entry_count | VARCHAR | 成交数量 |
| entry_money | DECIMAL | 成交金额 |
| entry_date | VARCHAR | 成交日期 |
| entry_time | VARCHAR | 成交时间 |

### t_trade_matched_record（匹配记录表）

| 字段 | 类型 | 说明 |
|------|------|------|
| sell_history_id | VARCHAR | 卖出记录 ID |
| buy_history_id | VARCHAR | 买入记录 ID |
| code | VARCHAR | 股票代码 |
| name | VARCHAR | 股票名称 |
| profit | DECIMAL | 盈亏金额 |
| sell_time | TIMESTAMP | 卖出时间 |
| buy_time | TIMESTAMP | 买入时间 |

## 故障排除

### Cookie 失效

**症状**：同步失败，API 返回鉴权错误（脚本只校验 Cookie 必要字段，无 24 小时时间戳限制；实测 Cookie 可长期有效）

**解决**：
```bash
opencli stock init
```

### 数据异常 / 需要重算

**症状**：收益数字可疑、匹配结果与预期不符

**解决**（sync/match 均为幂等操作，直接重跑即可，**禁止手写 SQL DELETE 修复数据**）：
```bash
# 重拉交易记录（INSERT OR REPLACE，按 history_id 幂等覆盖）
node sync.js 20250101 $(date +%Y%m%d)

# 重跑匹配（只配对未匹配记录；费用字段以交易表最新数据为准）
# 注：已存在的旧配对不会自动重算；0 过户费的旧配对由 profit.js 查询时自动清理重建
node match.js 20250101 $(date +%Y%m%d)

# 重查收益（自动清理查询范围内 0 过户费脏数据）
node profit.js 2026-01 $(date +%Y-%m)
```

### 同步失败

**检查顺序**：
1. Cookie 是否失效（API 返回鉴权错误时 `opencli stock init`）
2. 网络是否正常
3. 日期格式是否正确
4. 是否 API 限流（等待 30 秒重试）

### 匹配失败

**检查顺序**：
1. 是否已同步数据
2. 时间范围是否匹配
3. 数据库是否有数据

## 开发

### 项目结构

```
stock-skill/
├── SKILL.md           # 技能定义（agent 入口文档）
├── README.md          # 本文档
├── test-prompts.json  # 触发测试用例
├── references/        # 详细参考（故障排除/反模式）
│   ├── troubleshooting.md
│   └── anti-patterns.md
├── resources/
│   └── stock/         # opencli 插件
│       ├── init.js    # Cookie 获取脚本
│       └── package.json
└── scripts/           # 核心脚本
    ├── api-client.js  # 共享 HTTP 客户端
    ├── business.js    # 业务逻辑（同步/匹配/收益）
    ├── db.js          # 数据库连接
    ├── utils.js       # 工具函数
    ├── constants.js   # 常量定义
    ├── sql-sync.js    # 同步 SQL
    ├── sql-schema.js  # 表结构 + 索引
    ├── sql-match.js   # 匹配 SQL
    ├── sql-profit.js  # 收益 SQL
    ├── quotes-api.js  # 行情 API
    ├── init-db.js     # 数据库初始化
    ├── sync.js        # 交易同步入口
    ├── match.js       # 交易匹配入口
    ├── profit.js      # 收益查询入口
    ├── quotes.js      # 行情查询入口
    ├── account-profit.js  # 账户收益入口
    ├── unmatched.js   # 未匹配记录查询
```

### 运行测试

```bash
cd ~/.agents/skills/stock-skill/scripts

# 测试同步
node sync.js 20260901 20260930

# 测试匹配
node match.js 20260901 20260930

# 测试收益查询
node profit.js 2026-09

# 测试行情查询
node quotes.js
```

## 许可证

MIT License
