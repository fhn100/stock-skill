import { withDb } from './db.js';

async function getYaoMingBiDetails() {
  return await withDb(async (conn) => {
    const rows = await conn.all('* FROM t_trade_matched_record WHERE code = ''02269'' ORDER BY sell_time DESC LIMIT 5');
    return rows;
  });
}

getYaoMingBiDetails().then(rows => {
  if (rows.length > 0) {
    const latest = rows[0];
    const latestProfit = parseFloat(latest.profit.toString());
    const sellPrice = parseFloat(latest.sell_entry_price.toString());
    const buyPrice = parseFloat(latest.buy_entry_price.toString());
    const count = parseInt(latest.sell_entry_count);
    
    let sellTime;
    if (latest.sell_time && typeof latest.sell_time !== 'string') {
      sellTime = new Date(Number(latest.sell_time.micros) / 1000);
    } else {
      sellTime = new Date(String(latest.sell_time));
    }

    console.log('✅ 药明生物 (02269) 最近一笔网格收益：');
    console.log('   卖出时间:', sellTime.toLocaleTimeString());
    console.log('   卖出价格:', sellPrice.toFixed(4), '元/股');
    console.log('   买入价格:', buyPrice.toFixed(4), '元/股');
    console.log('   交易数量:', count, '股');
    console.log('   ✅ 最终收益: ¥' + latestProfit.toFixed(2));
    console.log('   （该收益已包含买卖手续费净额）');
  }
}).catch(e => console.error(e));