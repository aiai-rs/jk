/**
 * Telegram Logger Bot - 终极增强版 (高级UI + 严格权限隔离)
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

// 统一的大键盘
const MAIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 指令菜单'],
    ['/cksq 授权管理', '/sc 清空数据']
]).resize().persistent();

// ==========================================
// 2. 高级提示文案 (UI 美化部分)
// ==========================================

// 样式1：完全未授权
const NO_AUTH_MSG = `
⛔️ <b>访问被拒绝 (Access Denied)</b>

你还没有获得授权，请授权后再试。

👮‍♂️ <b>管理员:</b> @rrss0
`;

// 样式2：已授权但权限不足 (点了别的按钮)
const LOW_PERM_MSG = `
⛔️ <b>权限不足 (Permission Denied)</b>

你没有操作该功能的权限，请联系管理员。

👮‍♂️ <b>管理员:</b> @rrss0
`;

// ==========================================
// 3. 数据库初始化
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
// 4. 核心功能函数
// ==========================================

// 警报系统：通知老板有未授权访问
async function notifyAdminUnauthorized(ctx) {
    if (ctx.from.id === ADMIN_ID) return;

    const u = ctx.from;
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const content = ctx.message ? (ctx.message.text || '[非文本消息]') : '[动作]';

    const alertMsg = `🚨 <b>未授权访问警告</b>\n\n` +
                     `👤 <b>用户:</b> ${u.first_name} ${u.last_name || ''}\n` +
                     `📛 <b>用户名:</b> @${u.username || '无'}\n` +
                     `🆔 <b>ID:</b> <code>${u.id}</code>\n` +
                     `⏰ <b>时间:</b> ${time}\n` +
                     `💬 <b>尝试发送:</b> ${content}`;
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, alertMsg, { parse_mode: 'HTML' });
    } catch (e) { console.error('警报发送失败', e); }
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

// 检查授权
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

// 检查是否在群
async function isUserInChat(userId, chatId) {
    if (userId === ADMIN_ID) return true;
    try {
        const member = await bot.telegram.getChatMember(chatId, userId);
        return !(member.status === 'left' || member.status === 'kicked');
    } catch (e) { return false; }
}

// ==========================================
// 5. 中间件 (全局拦截)
// ==========================================

// 1. 群消息记录
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

// 2. 私聊权限拦截
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) {
        const userId = ctx.from.id;
        const isAuth = await checkAuth(userId);

        if (!isAuth) {
            // 🚨 1. 报警给老板
            await notifyAdminUnauthorized(ctx);
            // ⛔️ 2. 回复高级格式的拒绝信息
            await ctx.reply(NO_AUTH_MSG, { parse_mode: 'HTML' });
            return; // 拦截，不让继续
        }
    }
    await next();
});

// ==========================================
// 6. 指令集
// ==========================================

// --- /start: 唯一入口 ---
bot.start(async (ctx) => {
    // 中间件已确保用户有授权
    await ctx.reply('👋 欢迎回来，请使用下方键盘操作。', MAIN_KEYBOARD);
});

// --- /ck: 查日志 (授权用户唯一可用功能) ---
bot.command('ck', async (ctx) => {
    const userId = ctx.from.id;
    // 权限检查在中件层其实已经做过，但为了安全保留
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

// --- 下面是“管理员独享”指令 (普通授权用户点击直接报错) ---

// 统一的权限拦截器
const adminOnly = async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' });
    }
    await next();
};

// 1. /bz 菜单 (普通用户点了报错)
bot.command('bz', adminOnly, async (ctx) => {
    await ctx.reply(`📜 **管理员菜单**\n/ck - 查记录\n/rz ID - 查某人\n/sq ID - 授权\n/cksq - 管理授权\n/sc - 清空数据`, MAIN_KEYBOARD);
});

// 2. /cksq 授权管理 (普通用户点了报错)
bot.command('cksq', adminOnly, async (ctx) => {
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('📂 无授权用户。');
    const buttons = res.rows.map(u => [
        Markup.button.callback(`❌ 撤销: ${u.user_id} (${u.is_permanent ? '永久' : '限时'})`, `revoke_${u.user_id}`)
    ]);
    await ctx.reply('📋 授权管理:', Markup.inlineKeyboard(buttons));
});

// 3. /sc 清空数据 (普通用户点了报错)
bot.command('sc', adminOnly, async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.reply('请私聊操作。');
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 空数据库。');
    const buttons = res.rows.map(g => [Markup.button.callback(`🗑️ 删除: ${g.chat_title}`, `pre_wipe_${g.chat_id}`)]);
    await ctx.reply('⚠️ 选择要清空的群组:', Markup.inlineKeyboard(buttons));
});

// 4. /sq 授权指令 (普通用户点了没反应，因为需要参数，或者直接报错)
bot.command('sq', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 格式: /sq 数字ID');
    global.sqTarget = input;
    const timeButtons = [
        [Markup.button.callback('1小时', 'auth_1h'), Markup.button.callback('3小时', 'auth_3h'), Markup.button.callback('6小时', 'auth_6h')],
        [Markup.button.callback('1天', 'auth_1d'), Markup.button.callback('3天', 'auth_3d'), Markup.button.callback('6天', 'auth_6d')],
        [Markup.button.callback('♾️ 永久', 'auth_perm')]
    ];
    await ctx.reply(`🛡️ 正在授权给 ID: \`${input}\`\n请选择有效时长:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(timeButtons) });
});

// 5. /rz 查人 (管理员专用)
bot.command('rz', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply('用法: /rz ID');
    await sendLogPage(ctx, 'user', input.replace('@', ''), 1);
});

// ==========================================
// 7. 回调处理 (Action)
// ==========================================

// 查看群组 (授权用户可用，但必须在群内)
bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const targetChatId = ctx.match[1];

    if (!(await checkAuth(userId))) return ctx.answerCbQuery('无权限'); // 双保险

    const canAccess = await isUserInChat(userId, targetChatId);
    if (!canAccess) {
        // 🔥 试图看不在的群：弹窗报错
        return ctx.answerCbQuery('⛔️ 你没有权限，如有疑问请联系管理员 @rrss0', { show_alert: true });
    }
    await sendLogPage(ctx, 'group', targetChatId, 1);
});

// 管理员操作回调拦截
const adminAction = async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('无权限');
    await next();
};

bot.action(/auth_(.+)/, adminAction, async (ctx) => {
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
    await pool.query(`INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`, [targetId, ADMIN_ID, isPerm ? null : expires, isPerm]);
    await ctx.editMessageText(`✅ 已授权用户 \`${targetId}\`\n⏳ 时长: ${text}`, { parse_mode: 'Markdown' });
});

bot.action(/revoke_(\d+)/, adminAction, async (ctx) => {
    const targetId = ctx.match[1];
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetId]);
    await ctx.answerCbQuery('已撤销');
    await ctx.editMessageText(`✅ 用户 ${targetId} 授权已取消。`);
});

bot.action(/pre_wipe_(-?\d+)/, adminAction, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.editMessageText(`🛑 确定清空 ID \`${chatId}\` 的记录吗？不可恢复！`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ 确认', `do_wipe_${chatId}`)], [Markup.button.callback('🔙 取消', 'cancel_action')]])
    });
});

bot.action(/do_wipe_(-?\d+)/, adminAction, async (ctx) => {
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [ctx.match[1]]);
    await ctx.editMessageText(`✅ 数据已清空。`);
});
bot.action('cancel_action', (ctx) => ctx.deleteMessage());

// 翻页通用
async function sendLogPage(ctx, type, target, page) {
    const limit = 10;
    const offset = (page - 1) * limit;
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else { if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); } else { sql += `username = $1`; params.push(target); } }
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

    const buttons = [[Markup.button.callback('⬅️', `page_${type}_${target}_${page - 1}`), Markup.button.callback('⬇️ TXT', `export_${type}_${target}`), Markup.button.callback('➡️', `page_${type}_${target}_${page + 1}`)]];
    if (ctx.callbackQuery) try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }); } catch(e){}
    else await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => {
    let page = parseInt(ctx.match[3]); if (page < 1) page = 1;
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
// 8. 启动
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
const stopBot = (signal) => { console.log(`🛑 ${signal}`); bot.stop(signal); pool.end(); process.exit(0); };
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
