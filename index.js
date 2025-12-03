/**
 * Telegram Logger Bot - 终极增强版 (报警系统 + 细粒度授权 + 丰富时长)
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');

// ==========================================
// 1. 基础配置
// ==========================================
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

// 统一的大键盘 (包含所有指令)
const MAIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 指令菜单'],
    ['/cksq 授权管理', '/sc 清空数据']
]).resize().persistent();

// ==========================================
// 2. 数据库初始化
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

// ==========================================
// 3. 核心功能函数
// ==========================================

// 警报系统：通知老板有未授权访问
async function notifyAdminUnauthorized(ctx) {
    // 防止自己触发报警
    if (ctx.from.id === ADMIN_ID) return;

    const u = ctx.from;
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const content = ctx.message ? (ctx.message.text || '[非文本消息]') : '[点击按钮/动作]';

    const alertMsg = `🚨 <b>未授权访问警告</b>\n\n` +
                     `👤 <b>用户:</b> ${u.first_name} ${u.last_name || ''}\n` +
                     `📛 <b>用户名:</b> @${u.username || '无'}\n` +
                     `🆔 <b>ID:</b> <code>${u.id}</code>\n` +
                     `⏰ <b>时间:</b> ${time}\n` +
                     `💬 <b>尝试发送:</b> ${content}`;
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, alertMsg, { parse_mode: 'HTML' });
    } catch (e) {
        console.error('发送警报失败:', e);
    }
}

// 记录日志
async function logMessage(ctx, eventType, oldContent = null) {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg || ctx.chat.type === 'private') return;

    const content = msg.text || msg.caption || `[媒体消息]`;
    const chatTitle = msg.chat.title || '未知群组';
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    try {
        await pool.query(
            `INSERT INTO messages (msg_id, chat_id, chat_title, user_id, username, first_name, content, event, original_content)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [msg.message_id, msg.chat.id, chatTitle, msg.from.id, username, firstName, content, eventType, oldContent]
        );
    } catch (e) { console.error('Log Error:', e); }
}

async function getOldContent(msgId, chatId) {
    const res = await pool.query(
        `SELECT content FROM messages WHERE msg_id = $1 AND chat_id = $2 AND event = 'send' ORDER BY id DESC LIMIT 1`,
        [msgId, chatId]
    );
    return res.rows[0] ? res.rows[0].content : '[无历史内容]';
}

// 检查授权 (核心逻辑)
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

// 检查用户是否在群里
async function isUserInChat(userId, chatId) {
    if (userId === ADMIN_ID) return true;
    try {
        const member = await bot.telegram.getChatMember(chatId, userId);
        return !(member.status === 'left' || member.status === 'kicked');
    } catch (e) {
        return false;
    }
}

// ==========================================
// 4. 中间件 (全局拦截)
// ==========================================

// 1. 群消息记录 (最优先)
bot.on('message', async (ctx, next) => {
    if (ctx.chat.type !== 'private') await logMessage(ctx, 'send');
    await next();
});

bot.on('edited_message', async (ctx, next) => {
    if (ctx.chat.type !== 'private') {
        const old = await getOldContent(ctx.editedMessage.message_id, ctx.chat.id);
        await logMessage(ctx, 'edit', old);
    }
    await next();
});

// 2. 私聊权限拦截与报警
bot.use(async (ctx, next) => {
    // 只处理私聊的文本消息
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) {
        const userId = ctx.from.id;
        const isAuth = await checkAuth(userId);

        if (!isAuth) {
            // 🚫 未授权用户：发送警报给老板，不回复用户(或者回复拒绝)
            await notifyAdminUnauthorized(ctx);
            // 可以选择完全不理，或者回复一句
            // await ctx.reply('⛔️ 未授权访问。'); 
            return; // 终止后续处理，指令也不会触发
        }
    }
    await next();
});

// ==========================================
// 5. 指令集
// ==========================================

// --- /start: 唤醒键盘 ---
bot.start(async (ctx) => {
    // 能进来说明已经通过了中间件的 checkAuth (如果是私聊)
    // 或者需要再次检查以防万一
    if (await checkAuth(ctx.from.id)) {
        await ctx.reply('👋 欢迎使用日志机器人，键盘已激活。', MAIN_KEYBOARD);
    }
});

// --- /bz: 菜单 ---
bot.command('bz', async (ctx) => {
    await ctx.reply(`📜 **指令菜单**\n/ck - 查记录\n/start - 唤出键盘\n/rz ID - 查某人 (需权限)\n/sq ID - 授权 (老板用)\n/cksq - 管理授权 (老板用)\n/sc - 清空数据 (老板用)`, MAIN_KEYBOARD);
});

// --- /ck: 查日志 ---
bot.command('ck', async (ctx) => {
    const userId = ctx.from.id;
    // 双重检查
    if (!(await checkAuth(userId))) return;

    if (ctx.chat.type !== 'private') {
        return sendLogPage(ctx, 'group', ctx.chat.id, 1);
    }

    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 暂无群组记录。');

    const buttons = res.rows.map(g => [
        Markup.button.callback(`📂 ${g.chat_title} (ID: ${g.chat_id})`, `view_group_${g.chat_id}`)
    ]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

// 点击查看群组 (权限核心)
bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const targetChatId = ctx.match[1];

    if (!(await checkAuth(userId))) return ctx.answerCbQuery('无权限');

    // 🔥 检查是否在群
    const canAccess = await isUserInChat(userId, targetChatId);
    if (!canAccess) {
        // 按照要求修改提示语
        return ctx.answerCbQuery('你没有权限，如有疑问请联系管理员 @rrss0', { show_alert: true });
    }

    await sendLogPage(ctx, 'group', targetChatId, 1);
});

// --- /sq: 授权 (多时间选项) ---
bot.command('sq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 格式: /sq 数字ID');
    
    global.sqTarget = input;
    
    // 生成丰富的时间按钮
    const timeButtons = [
        [Markup.button.callback('1小时', 'auth_1h'), Markup.button.callback('3小时', 'auth_3h'), Markup.button.callback('6小时', 'auth_6h')],
        [Markup.button.callback('1天', 'auth_1d'), Markup.button.callback('3天', 'auth_3d'), Markup.button.callback('6天', 'auth_6d')],
        [Markup.button.callback('♾️ 永久', 'auth_perm')]
    ];

    await ctx.reply(`🛡️ 正在授权给 ID: \`${input}\`\n请选择有效时长:`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(timeButtons)
    });
});

// 处理授权时长
bot.action(/auth_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const type = ctx.match[1];
    const targetId = global.sqTarget;
    
    let expires = new Date();
    let isPerm = false;
    let text = '';

    switch(type) {
        case '1h': expires.setHours(expires.getHours() + 1); text = '1小时'; break;
        case '3h': expires.setHours(expires.getHours() + 3); text = '3小时'; break;
        case '6h': expires.setHours(expires.getHours() + 6); text = '6小时'; break;
        case '1d': expires.setDate(expires.getDate() + 1); text = '1天'; break;
        case '3d': expires.setDate(expires.getDate() + 3); text = '3天'; break;
        case '6d': expires.setDate(expires.getDate() + 6); text = '6天'; break;
        case 'perm': isPerm = true; text = '永久'; break;
    }

    await pool.query(
        `INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (user_id) 
         DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`, 
        [targetId, ADMIN_ID, isPerm ? null : expires, isPerm]
    );
    
    await ctx.editMessageText(`✅ 已授权用户 \`${targetId}\`\n⏳ 时长: ${text}`, { parse_mode: 'Markdown' });
});

// --- /cksq: 撤销授权 (保持原样) ---
bot.command('cksq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('📂 无授权用户。');

    const buttons = res.rows.map(u => [
        Markup.button.callback(`❌ 撤销: ${u.user_id} (${u.is_permanent ? '永久' : '限时'})`, `revoke_${u.user_id}`)
    ]);
    await ctx.reply('📋 授权管理:', Markup.inlineKeyboard(buttons));
});

bot.action(/revoke_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetId]);
    await ctx.answerCbQuery('已撤销');
    await ctx.editMessageText(`✅ 用户 ${targetId} 授权已取消。`);
});

// --- /sc: 清除数据 (保持原样) ---
bot.command('sc', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (ctx.chat.type !== 'private') return ctx.reply('请私聊操作。');
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 空数据库。');
    const buttons = res.rows.map(g => [Markup.button.callback(`🗑️ 删除: ${g.chat_title}`, `pre_wipe_${g.chat_id}`)]);
    await ctx.reply('⚠️ 选择要清空的群组:', Markup.inlineKeyboard(buttons));
});

bot.action(/pre_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const chatId = ctx.match[1];
    await ctx.editMessageText(`🛑 确定清空 ID \`${chatId}\` 的记录吗？不可恢复！`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ 确认', `do_wipe_${chatId}`)], [Markup.button.callback('🔙 取消', 'cancel_action')]])
    });
});

bot.action(/do_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [ctx.match[1]]);
    await ctx.editMessageText(`✅ 数据已清空。`);
});
bot.action('cancel_action', (ctx) => ctx.deleteMessage());

// --- /rz: 查某人 ---
bot.command('rz', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return; // 中间件已经拦截了，这里双保险
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply('用法: /rz ID');
    if (ctx.from.id !== ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🔔 监控: ${ctx.from.id} 查了 ${input}`).catch(()=>{});
    await sendLogPage(ctx, 'user', input.replace('@', ''), 1);
});

// --- 日志翻页 ---
async function sendLogPage(ctx, type, target, page) {
    const limit = 10;
    const offset = (page - 1) * limit;
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];

    if (type === 'group') {
        sql += `chat_id = $1`; params.push(target);
    } else {
        if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); }
        else { sql += `username = $1`; params.push(target); }
    }
    sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const res = await pool.query(sql, params);
    let title = type==='group' ? '群组日志' : `用户日志: ${target}`;
    if (type === 'group' && res.rows.length > 0) title = res.rows[0].chat_title;
    
    let text = `📂 <b>${title}</b> (第 ${page} 页)\n\n`;
    if (res.rows.length === 0) text += "无记录。";
    
    res.rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const name = l.first_name || '无名';
        if (l.event === 'edit') text += `✏️ <b>${name}</b> [${time}] 编辑:\n🗑 ${l.original_content}\n🆕 ${l.content}\n\n`;
        else text += `💬 <b>${name}</b> [${time}]:\n${l.content}\n\n`;
    });

    const buttons = [[
        Markup.button.callback('⬅️', `page_${type}_${target}_${page - 1}`),
        Markup.button.callback('⬇️ TXT', `export_${type}_${target}`),
        Markup.button.callback('➡️', `page_${type}_${target}_${page + 1}`)
    ]];

    if (ctx.callbackQuery) try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }); } catch(e){}
    else await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => {
    let page = parseInt(ctx.match[3]);
    if (page < 1) page = 1;
    await sendLogPage(ctx, ctx.match[1], ctx.match[2], page);
});

bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    const type = ctx.match[1], target = ctx.match[2];
    await ctx.answerCbQuery('生成中...');
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else { if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); } else { sql += `username = $1`; params.push(target); } }
    sql += ` ORDER BY created_at DESC LIMIT 5000`;
    const res = await pool.query(sql, params);
    let content = `Log Export: ${target}\n\n`;
    res.rows.forEach(l => content += `[${new Date(l.created_at).toLocaleString()}] ${l.first_name}: ${l.content}\n`);
    await ctx.replyWithDocument({ source: Buffer.from(content), filename: `log_${target}.txt` });
});

// ==========================================
// 6. 启动 (防冲突版)
// ==========================================
initDB().then(async () => {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🔄 Webhook 已清除');
        await bot.launch({ dropPendingUpdates: true, polling: { timeout: 30, limit: 100 } });
        console.log('🚀 机器人终极版启动成功！');
    } catch (e) { console.error('启动失败:', e); }
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);

const stopBot = (signal) => {
    console.log(`🛑 ${signal} 关闭...`);
    bot.stop(signal);
    pool.end();
    process.exit(0);
};
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
