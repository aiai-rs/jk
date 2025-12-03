/**
 * Telegram Logger Bot - 统计报表 & 永久记录版
 * * 核心修复：
 * 1. 强制键盘唤醒 (/start)
 * 2. 导出 TXT 带详细统计头 (谁发了多少条，谁编辑过)
 * 3. 记录所有发言 (需关闭 Group Privacy)
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !ADMIN_ID || !DATABASE_URL) {
    console.error('❌ 错误：环境变量缺失');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- 键盘定义 ---
const ADMIN_KEYBOARD = Markup.keyboard([
    ['/ck 本群记录', '/bz 所有指令'],
    ['/cksq 管理授权', '/sc 清空数据']
]).resize().persistent(); // 强制持久化

const AUTH_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志']
]).resize().persistent();

// ==========================================
// 1. 数据库 & 初始化
// ==========================================
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                msg_id BIGINT,
                chat_id BIGINT,
                chat_title TEXT,
                user_id BIGINT,
                username TEXT,
                first_name TEXT,
                content TEXT,
                event TEXT, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                original_content TEXT
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                user_id BIGINT PRIMARY KEY,
                authorized_by BIGINT,
                expires_at TIMESTAMP,
                is_permanent BOOLEAN DEFAULT FALSE
            );
        `);
        console.log('✅ 数据库连接正常');
    } catch (err) {
        console.error('❌ 数据库错误:', err);
    } finally {
        client.release();
    }
}

// 记录函数
async function logMessage(ctx, eventType, oldContent = null) {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg) return;
    if (ctx.chat.type === 'private') return; 

    const content = msg.text || msg.caption || `[媒体消息]`;
    const chatTitle = msg.chat.title || '未知群组';
    
    // 自动更新 username (如果用户改名了)
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    try {
        await pool.query(
            `INSERT INTO messages (msg_id, chat_id, chat_title, user_id, username, first_name, content, event, original_content)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [msg.message_id, msg.chat.id, chatTitle, msg.from.id, username, firstName, content, eventType, oldContent]
        );
    } catch (e) { console.error(e); }
}

async function getOldContent(msgId, chatId) {
    const res = await pool.query(
        `SELECT content FROM messages WHERE msg_id = $1 AND chat_id = $2 AND event = 'send' ORDER BY id DESC LIMIT 1`,
        [msgId, chatId]
    );
    return res.rows[0] ? res.rows[0].content : '[无历史内容]';
}

async function checkAuth(userId) {
    if (userId === ADMIN_ID) return true;
    const res = await pool.query('SELECT * FROM auth_sessions WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) return false;
    const session = res.rows[0];
    if (session.is_permanent) return true;
    if (new Date() > new Date(session.expires_at)) {
        await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
        return false;
    }
    return true;
}

// ==========================================
// 2. 中间件 (日志优先记录)
// ==========================================

// 记录所有群消息
bot.on('message', async (ctx, next) => {
    if (ctx.chat.type !== 'private') {
        await logMessage(ctx, 'send');
    }
    await next();
});

bot.on('edited_message', async (ctx, next) => {
    if (ctx.chat.type !== 'private') {
        const old = await getOldContent(ctx.editedMessage.message_id, ctx.chat.id);
        await logMessage(ctx, 'edit', old);
    }
    await next();
});

// 自动回复与键盘唤醒
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private') {
        const userId = ctx.from.id;
        
        // 专门处理 /start 以唤醒键盘
        if (ctx.message && ctx.message.text === '/start') {
            if (userId === ADMIN_ID) {
                await ctx.reply('👮‍♂️ 老板好！系统已就绪，键盘已唤醒。', ADMIN_KEYBOARD);
            } else if (await checkAuth(userId)) {
                await ctx.reply('✅ 授权已确认，请使用下方按钮。', AUTH_KEYBOARD);
            } else {
                await ctx.reply('⛔️ 只有授权用户可使用本机器人。\n请联系管理员获取 /sq 授权，并告知您的 ID: ' + userId);
            }
            return;
        }

        // 普通对话回复 "在的"
        if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
            if (userId === ADMIN_ID) {
                await ctx.reply('👮‍♂️ 老板我在！', ADMIN_KEYBOARD);
            } else if (await checkAuth(userId)) {
                await ctx.reply('🤖 机器人运行中...', AUTH_KEYBOARD);
            }
        }
    }
    await next();
});

// ==========================================
// 3. 统计与导出逻辑 (核心升级)
// ==========================================

function generateStats(rows, title) {
    let totalMsgs = 0;
    let editCount = 0;
    let userStats = {}; // { userID: { name, count, edits } }

    rows.forEach(row => {
        const uid = row.user_id;
        if (!userStats[uid]) {
            userStats[uid] = { name: row.first_name, username: row.username, count: 0, edits: 0 };
        }
        
        if (row.event === 'edit') {
            editCount++;
            userStats[uid].edits++;
        } else {
            totalMsgs++;
            userStats[uid].count++;
        }
    });

    // 构建头部统计文本
    let header = `========================================\n`;
    header += `📊 群组统计报告: ${title}\n`;
    header += `📅 生成时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
    header += `📄 总记录数: ${rows.length} 条\n`;
    header += `💬 发言总数: ${totalMsgs} 条\n`;
    header += `✏️ 编辑总数: ${editCount} 次\n`;
    header += `========================================\n`;
    header += `👥 用户活跃度统计 (Top Users):\n`;
    
    Object.values(userStats).forEach(u => {
        header += `   - ${u.name} (@${u.username||'无'}): 发言 ${u.count} / 编辑 ${u.edits}\n`;
    });
    header += `========================================\n\n`;
    header += `⬇️ 以下是详细日志记录 ⬇️\n\n`;

    return header;
}

// 导出功能
bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    const type = ctx.match[1];
    const target = ctx.match[2];
    await ctx.answerCbQuery('正在生成详细报表...');

    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    
    if (type === 'group') {
        sql += `chat_id = $1`;
        params.push(target);
    } else {
        if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); }
        else { sql += `username = $1`; params.push(target); }
    }
    sql += ` ORDER BY created_at DESC LIMIT 5000`; // 提高上限到5000条

    const res = await pool.query(sql, params);
    if (res.rows.length === 0) return ctx.reply('该范围内没有数据可导出。');

    // 获取群名/用户名用于文件名
    let fileNameTarget = target;
    let reportTitle = target;
    if (res.rows[0]) {
        if (type === 'group') {
            fileNameTarget = res.rows[0].chat_title || target;
            reportTitle = res.rows[0].chat_title;
        } else {
            fileNameTarget = res.rows[0].first_name || target;
            reportTitle = res.rows[0].first_name;
        }
    }
    // 清理文件名非法字符
    fileNameTarget = fileNameTarget.replace(/[\/\\:*?"<>|]/g, '_');

    // 1. 生成统计头
    let fileContent = generateStats(res.rows, reportTitle);

    // 2. 追加日志详情
    res.rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const name = `${l.first_name} (ID:${l.user_id})`;
        
        if (l.event === 'edit') {
            fileContent += `[${time}] ✏️ [编辑] ${name}\n`;
            fileContent += `      📝 原文: ${l.original_content}\n`;
            fileContent += `      🆕 现文: ${l.content}\n`;
        } else {
            fileContent += `[${time}] 💬 [发言] ${name}: ${l.content}\n`;
        }
        fileContent += `----------------------------------------\n`;
    });

    const buffer = Buffer.from(fileContent, 'utf-8');
    await ctx.replyWithDocument({ source: buffer, filename: `Report_${fileNameTarget}.txt` });
});

// ==========================================
// 4. 其他指令 (/ck, /rz, /bz 等)
// ==========================================

bot.command('bz', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.reply(`📜 **指令列表**\n/ck - 查日志 (群内或私聊)\n/sq ID - 授权\n/cksq - 查授权\n/sc - 清空`, ADMIN_KEYBOARD);
});

bot.command('ck', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return ctx.reply('无权访问。');

    // 群组模式
    if (ctx.chat.type !== 'private') {
        return sendLogPage(ctx, 'group', ctx.chat.id, 1);
    }

    // 私聊模式
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 暂无群组记录。');
    
    const buttons = res.rows.map(g => [Markup.button.callback(`📂 ${g.chat_title}`, `view_group_${g.chat_id}`)]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

bot.action(/view_group_(-?\d+)/, async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return ctx.answerCbQuery('无权限');
    await sendLogPage(ctx, 'group', ctx.match[1], 1);
});

// 通用发送日志页面的函数
async function sendLogPage(ctx, type, target, page) {
    const limit = 10;
    const offset = (page - 1) * limit;
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];

    if (type === 'group') {
        sql += `chat_id = $1`;
        params.push(target);
    } else { // user
        if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); }
        else { sql += `username = $1`; params.push(target); }
    }
    sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const res = await pool.query(sql, params);
    
    // 生成显示文本
    let title = type==='group' ? '群组日志' : '用户日志';
    if (res.rows.length > 0) {
        title = type==='group' ? res.rows[0].chat_title : res.rows[0].first_name;
    }
    
    let text = `📂 <b>${title}</b> (第 ${page} 页)\n\n`;
    if (res.rows.length === 0) text += "无更多记录。";
    
    res.rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        if (l.event === 'edit') {
            text += `✏️ <b>${l.first_name}</b> 编辑:\n🗑 旧: ${l.original_content}\n🆕 新: ${l.content}\n\n`;
        } else {
            text += `💬 <b>${l.first_name}</b>: ${l.content}\n\n`;
        }
    });

    const buttons = [
        [
            Markup.button.callback('⬅️ 上页', `page_${type}_${target}_${page - 1}`),
            Markup.button.callback('⬇️ 导出完整TXT', `export_${type}_${target}`),
            Markup.button.callback('➡️ 下页', `page_${type}_${target}_${page + 1}`)
        ]
    ];

    // 如果是 edit (callback)
    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        } catch(e) { await ctx.answerCbQuery('无变化'); }
    } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
}

// 翻页 Action
bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => {
    let page = parseInt(ctx.match[3]);
    if (page < 1) page = 1;
    await sendLogPage(ctx, ctx.match[1], ctx.match[2], page);
});

// 授权与清空
bot.command('sq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 必须输入数字 ID。');
    global.sqTarget = input; 
    await ctx.reply(`为 ID ${input} 授权时长:`, Markup.inlineKeyboard([[Markup.button.callback('1天', 'auth_24'), Markup.button.callback('永久', 'auth_perm')]]));
});

bot.action(/auth_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const duration = ctx.match[1];
    const targetId = global.sqTarget;
    let expires = null;
    let perm = duration === 'perm';
    if (!perm) { const d = new Date(); d.setHours(d.getHours()+24); expires = d; }
    await pool.query(`INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`, [targetId, ADMIN_ID, expires, perm]);
    await ctx.editMessageText(`✅ 已授权 ${targetId}`);
});

bot.command('cksq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const res = await pool.query('SELECT * FROM auth_sessions');
    let t = '授权名单:\n'; res.rows.forEach(u=>t+=`${u.user_id} (${u.is_permanent?'永久':'限时'})\n`);
    await ctx.reply(t, ADMIN_KEYBOARD);
});

bot.command('sc', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (ctx.chat.type === 'private') return ctx.reply('请在群内使用');
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [ctx.chat.id]);
    await ctx.reply('🗑️ 已清空。');
});

initDB().then(() => {
    bot.launch();
    console.log('🚀 机器人全场景版启动成功！');
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);
process.once('SIGINT', () => bot.stop('SIGINT'));
