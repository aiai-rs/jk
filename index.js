/**
 * Telegram Logger Bot - 监控通知增强版
 * 平台：Render (PostgreSQL)
 * 特性：严格权限、数据持久化、授权用户操作通知管理员
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');

// ==========================================
// 1. 配置区域
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // 你的 ID
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !ADMIN_ID || !DATABASE_URL) {
    console.error('❌ 错误：请检查环境变量 BOT_TOKEN, ADMIN_ID, DATABASE_URL');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// PostgreSQL 连接
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// 2. 数据库逻辑
// ==========================================

async function initDB() {
    const client = await pool.connect();
    try {
        // 消息表
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
                event TEXT, -- 'send' or 'edit'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                original_content TEXT
            );
        `);

        // 授权表
        await client.query(`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                authorized_by BIGINT,
                expires_at TIMESTAMP,
                is_permanent BOOLEAN DEFAULT FALSE
            );
        `);
        console.log('✅ 数据库连接成功');
    } catch (err) {
        console.error('❌ 数据库错误:', err);
    } finally {
        client.release();
    }
}

// 记录消息
async function logMessage(msg, eventType, oldContent = null) {
    const content = msg.text || msg.caption || '[非文本消息]';
    const chatTitle = msg.chat.title || '私聊';
    
    await pool.query(
        `INSERT INTO messages (msg_id, chat_id, chat_title, user_id, username, first_name, content, event, original_content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [msg.message_id, msg.chat.id, chatTitle, msg.from.id, msg.from.username, msg.from.first_name, content, eventType, oldContent]
    );
}

// 获取旧消息内容
async function getOldContent(msgId, chatId) {
    const res = await pool.query(
        `SELECT content FROM messages WHERE msg_id = $1 AND chat_id = $2 AND event = 'send' ORDER BY id DESC LIMIT 1`,
        [msgId, chatId]
    );
    return res.rows[0] ? res.rows[0].content : '[无法获取旧内容]';
}

// 检查是否被授权
async function checkAuth(userId) {
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
// 3. 核心中间件：严格权限控制
// ==========================================

// 暂存授权操作的状态
const sessionState = new Map();

bot.use(async (ctx, next) => {
    // 1. 如果是消息记录逻辑，直接放行
    if (ctx.message && !ctx.message.text && !ctx.message.caption) return next();
    
    const text = ctx.message ? ctx.message.text : '';
    if (!text || !text.startsWith('/')) return next(); 

    const userId = ctx.from.id;
    const command = text.split(' ')[0].split('@')[0]; 

    // 2. 权限拦截
    const adminOnlyCommands = ['/sq', '/cksq', '/sc', '/bqjl']; 
    const authorizedCommands = ['/rz']; 

    // A. 只有你能用的指令
    if (adminOnlyCommands.includes(command)) {
        if (userId !== ADMIN_ID) {
            return ctx.reply(`没有权限如有疑问请联系 @rrss0`, { reply_to_message_id: ctx.message.message_id });
        }
    }

    // B. 授权人可用的指令
    if (authorizedCommands.includes(command)) {
        if (userId === ADMIN_ID) {
            return next();
        }
        const isAuth = await checkAuth(userId);
        if (!isAuth) {
            return ctx.reply(`没有权限如有疑问请联系 @rrss0`, { reply_to_message_id: ctx.message.message_id });
        }
    }

    return next();
});

// ==========================================
// 4. 功能实现
// ==========================================

// --- 日志监听 ---
bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') {
        await logMessage(ctx.message, 'send');
    }
    next();
});

bot.on('edited_message', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        const oldContent = await getOldContent(ctx.editedMessage.message_id, ctx.chat.id);
        await logMessage(ctx.editedMessage, 'edit', oldContent);
    }
});

// --- /rz: 查看日志 (重点修改：加入通知) ---
bot.command('rz', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('🔍 用法: /rz @username 或 ID');

    const target = args[1];
    const page = args[2] ? parseInt(args[2]) : 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    // 🔥【新增功能】如果是授权用户查的，立马通知你
    if (ctx.from.id !== ADMIN_ID) {
        const executor = `${ctx.from.first_name} (@${ctx.from.username || '无'})`;
        const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        
        // 异步发送通知，不阻塞查询
        bot.telegram.sendMessage(ADMIN_ID, 
            `🔔 **监控通知: 有人查日志！**\n\n` +
            `👤 操作人: ${executor}\n` +
            `🆔 ID: <code>${ctx.from.id}</code>\n` +
            `🔍 查询目标: ${target}\n` +
            `⏰ 时间: ${time}`, 
            { parse_mode: 'HTML' }
        ).catch(e => console.error('通知管理员失败', e));
    }

    // 正常的查询逻辑
    let query = `SELECT * FROM messages WHERE `;
    let values = [];

    if (/^\d+$/.test(target)) {
        query += `user_id = $1`;
        values.push(target);
    } else {
        query += `username = $1`;
        values.push(target.replace('@', ''));
    }
    
    query += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    values.push(limit, offset);

    try {
        const res = await pool.query(query, values);
        if (res.rows.length === 0) return ctx.reply(`📭 第 ${page} 页无记录。`);

        let msg = `📂 <b>日志查询: ${target}</b>\n\n`;
        res.rows.forEach(l => {
            const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            if (l.event === 'edit') {
                msg += `✏️ <b>[编辑]</b> ${time} (${l.chat_title})\n📝 旧: ${l.original_content}\n🆕 新: ${l.content}\n\n`;
            } else {
                msg += `💬 <b>[发言]</b> ${time} (${l.chat_title})\n📄 ${l.content}\n\n`;
            }
        });
        msg += `👉 下一页: <code>/rz ${target} ${page + 1}</code>`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply('❌ 查询出错。');
    }
});

// --- /bqjl: 查看本群记录 (仅限你) ---
bot.command('bqjl', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('⚠️ 请在群组中使用此指令。');

    const page = ctx.message.text.split(' ')[1] ? parseInt(ctx.message.text.split(' ')[1]) : 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const chatId = ctx.chat.id;

    try {
        const res = await pool.query(
            `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [chatId, limit, offset]
        );

        if (res.rows.length === 0) return ctx.reply(`📭 本群暂无记录 (第 ${page} 页)`);

        let msg = `📂 <b>本群日志 (${ctx.chat.title})</b>\n\n`;
        res.rows.forEach(l => {
            const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const userStr = `${l.first_name} (ID:${l.user_id})`;
            
            if (l.event === 'edit') {
                msg += `✏️ <b>${userStr} 编辑于 ${time}:</b>\n🗑 旧: ${l.original_content}\n🆕 新: ${l.content}\n\n`;
            } else {
                msg += `💬 <b>${userStr} 发言于 ${time}:</b>\n${l.content}\n\n`;
            }
        });
        
        msg += `👉 下一页: <code>/bqjl ${page + 1}</code>`;
        await ctx.reply(msg, { parse_mode: 'HTML' });

    } catch (e) {
        ctx.reply('❌ 读取群日志失败。');
    }
});

// --- /sq: 授权 (仅限你) ---
bot.command('sq', async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply('⚠️ 用法: /sq 用户ID');

    sessionState.set(`sq_target`, input);

    await ctx.reply(`🛡️ 正在授权给 ID: ${input}\n请选择时长:`, Markup.inlineKeyboard([
        [Markup.button.callback('1小时', 'auth_1'), Markup.button.callback('3小时', 'auth_3')],
        [Markup.button.callback('6小时', 'auth_6'), Markup.button.callback('1天', 'auth_24')],
        [Markup.button.callback('2天', 'auth_48'), Markup.button.callback('3天', 'auth_72')],
        [Markup.button.callback('♾️ 永久', 'auth_perm')]
    ]));
});

bot.action(/auth_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('你没有权限操作。');

    const duration = ctx.match[1];
    const targetId = sessionState.get(`sq_target`);
    if (!targetId) return ctx.reply('❌ 会话过期。');

    let expiresAt = null;
    let isPermanent = false;
    let label = '';

    if (duration === 'perm') {
        isPermanent = true;
        label = '永久';
    } else {
        const hours = parseInt(duration);
        const d = new Date();
        d.setHours(d.getHours() + hours);
        expiresAt = d;
        label = `${hours}小时`;
    }

    await pool.query(
        `INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET 
         expires_at = EXCLUDED.expires_at, is_permanent = EXCLUDED.is_permanent`,
        [targetId, ADMIN_ID, expiresAt, isPermanent]
    );

    await ctx.editMessageText(`✅ <b>授权成功</b>\n🆔 用户: <code>${targetId}</code>\n⏳ 时长: ${label}\n🔑 权限: 可使用 /rz 查看日志`, { parse_mode: 'HTML' });
});

// --- /cksq: 查看授权 (仅限你) ---
bot.command('cksq', async (ctx) => {
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('📂 无授权用户。');

    const buttons = res.rows.map(u => [
        Markup.button.callback(`❌ 撤销: ${u.user_id} (${u.is_permanent ? '永久' : '限时'})`, `revoke_${u.user_id}`)
    ]);

    await ctx.reply('📋 <b>当前授权列表 (点击撤销):</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/revoke_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetId]);
    await ctx.answerCbQuery('已撤销');
    await ctx.editMessageText(`✅ 用户 <code>${targetId}</code> 已撤销授权。`, { parse_mode: 'HTML' });
});

// --- /sc: 删库 (仅限你) ---
bot.command('sc', async (ctx) => {
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 数据库为空。');

    const buttons = res.rows.map(g => [
        Markup.button.callback(`🗑️ 删除: ${g.chat_title}`, `wipe_pre_${g.chat_id}`)
    ]);

    await ctx.reply('⚠️ <b>选择要清除数据的群组:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/wipe_pre_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const chatId = ctx.match[1];
    await ctx.editMessageText(`🛑 <b>二次确认</b>\n确定要清空该群数据吗？`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('☠️ 确认删除', `wipe_do_${chatId}`)],
            [Markup.button.callback('🔙 取消', 'cancel_wipe')]
        ])
    });
});

bot.action(/wipe_do_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const chatId = ctx.match[1];
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [chatId]);
    await ctx.editMessageText(`✅ 数据已彻底销毁。`, { parse_mode: 'HTML' });
});

bot.action('cancel_wipe', (ctx) => ctx.deleteMessage());

// ==========================================
// 5. 启动
// ==========================================

initDB().then(() => {
    bot.launch().then(() => {
        console.log(`🚀 机器人启动 (Admin: ${ADMIN_ID})`);
    });
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot Running');
}).listen(PORT, () => {
    console.log(`Port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
