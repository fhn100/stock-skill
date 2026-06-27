# 股票交易技能 (stock-skill)

基于 `opencli stock` 插件获取 Cookie，使用 Node.js 脚本管理股票交易数据。

## 功能

- 🍪 **Cookie 获取**：通过浏览器自动获取 Cookie
- 📊 **数据同步**：自动分页同步交易记录
- 🔗 **交易匹配**：自动匹配买卖记录
- 💰 **收益统计**：查询网格收益
- 📈 **实时行情**：获取持仓实时行情

## 安装

### 前置条件

1. **Node.js** v20+（推荐 v20.20.2）
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
git clone https://github.com/fhn100/stock-skill.git ~/.claude/skills/stock-skill

# 复制插件到 opencli 插件目录
cp -r ~/.claude/skills/stock-skill/resources/stock ~/.opencli/plugins/stock

# 安装插件依赖
cd ~/.opencli/plugins/stock && npm install
```

### 安装脚本依赖

```bash
cd ~/.claude/skills/stock-skill/scripts && npm install
```

## 快速开始

### 首次使用

```bash
# 1. 获取 Cookie（需要浏览器）
opencli stock init

# 2. 初始化数据库
cd ~/.claude/skills/stock-skill/scripts && node init-db.js

# 3. 同步交易记录
node sync.js 20250101 20260627

# 4. 匹配交易记录
node match.js 20250101 20260627

# 5. 查看收益
node profit.js
```

### 日常使用

```bash
cd ~/.claude/skills/stock-skill/scripts

# 同步当月数据
node sync.js

# 匹配交易记录
node match.js

# 查看本月收益
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
| `node profit.js` | `[startMonth] [endMonth]` | 查询收益，月份格式 YYYY-MM |
| `node quotes.js` | `[account]` | 查询实时行情，account 可选 |

## 数据存储

| 项目 | 路径 |
|------|------|
| 数据库 | `~/.duckdb/stock/stock.db` |
| 配置文件 | `~/.duckdb/stock/config` |
| 脚本目录 | `~/.claude/skills/stock-skill/scripts/` |

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

### Cookie 过期

**症状**：同步失败，提示 Cookie 错误

**解决**：
```bash
opencli stock init
```

### 数据库损坏

**症状**：各种 SQL 错误

**解决**：
```bash
# 备份
cp ~/.duckdb/stock/stock.db ~/.duckdb/stock/stock.db.bak

# 重新初始化
cd ~/.claude/skills/stock-skill/scripts && node init-db.js

# 重新同步
node sync.js 20250101 $(date +%Y%m%d)

# 重新匹配
node match.js 20250101 $(date +%Y%m%d)
```

### 同步失败

**检查顺序**：
1. Cookie 是否过期
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
├── SKILL.md           # Claude Code 技能定义
├── README.md          # 本文档
├── package.json       # 包配置
├── resources/
│   └── stock/         # opencli 插件
│       ├── init.js    # Cookie 获取脚本
│       └── package.json
├── scripts/           # 核心脚本
│   ├── business.js    # 业务逻辑
│   ├── db.js          # 数据库连接
│   ├── utils.js       # 工具函数
│   ├── constants.js   # 常量定义
│   ├── sql-sync.js    # 同步 SQL
│   ├── sql-schema.js  # 表结构 SQL
│   ├── sql-match.js   # 匹配 SQL
│   ├── sql-profit.js  # 收益 SQL
│   ├── quotes-api.js  # 行情 API
│   ├── init-db.js     # 数据库初始化
│   ├── sync.js        # 交易同步
│   ├── match.js       # 交易匹配
│   ├── profit.js      # 收益查询
│   └── quotes.js      # 行情查询
└── test-prompts.json  # 测试用例
```

### 运行测试

```bash
cd ~/.claude/skills/stock-skill/scripts

# 测试同步
node sync.js 20260601 20260630

# 测试匹配
node match.js 20260601 20260630

# 测试收益查询
node profit.js 2026-06

# 测试行情查询
node quotes.js
```

## 许可证

MIT License
