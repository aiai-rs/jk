/**
 * Telegram Logger Bot - 终极修复版 (409修复 + 权限隔离 + 图形化管理)
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

// 统一的大键盘 (所有人都能看到，但只有管理员能用所有功能)
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
// 3. 核心逻辑与权限检查
// ==========================================

// 记录日志 (放在最前，无条件记录)
async function logMessage(ctx, eventType, oldContent = null) {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg || ctx.chat.type === 'private') return;

    const content = msg.text || msg.caption || `[媒体消息]`;
    const chatTitle = msg.chat.title || '未知群组';
    
    // 实时更新 username
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

// 检查是否授权
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

// 检查用户是否在某个群 (解决问题4)
async function isUserInChat(userId, chatId) {
    // 老板无视规则
    if (userId === ADMIN_ID) return true;
    try {
        const member = await bot.telegram.getChatMember(chatId, userId);
        // 如果是 left(退群) 或 kicked(被踢)，则不允许看
        if (member.status === 'left' || member.status === 'kicked') return false;
        return true;
    } catch (e) {
        // 如果机器人读取失败(比如不在那个群了)，默认拒绝
        return false;
    }
}

// ==========================================
// 4. 中间件
// ==========================================

// 1. 记录所有群消息 (第一优先)
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

// 2. 自动回复与键盘 (私聊)
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
        const userId = ctx.from.id;
        if (await checkAuth(userId)) {
            // 无论是老板还是授权人，都显示同一个键盘，但权限由指令内部控制
            await ctx.reply('🤖 系统运行中...', MAIN_KEYBOARD);
        } else {
            // 未授权不做反应或提示
        }
    }
    await next();
});

// ==========================================
// 5. 指令集
// ==========================================

// --- /bz: 菜单 ---
bot.command('bz', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return;
    await ctx.reply(`📜 **指令菜单**\n/ck - 查记录 (群内/私聊)\n/rz ID - 查某人\n/sq ID - 授权\n/cksq - 管理授权\n/sc - 清空数据`, MAIN_KEYBOARD);
});

// --- /ck: 查日志 (解决问题4: 隔离权限) ---
bot.command('ck', async (ctx) => {
    const userId = ctx.from.id;
    if (!(await checkAuth(userId))) return ctx.reply('⛔️ 无权访问。');

    // 场景A: 群里直接查
    if (ctx.chat.type !== 'private') {
        return sendLogPage(ctx, 'group', ctx.chat.id, 1);
    }

    // 场景B: 私聊查，列出所有群
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 暂无群组记录。');

    // 生成按钮
    const buttons = res.rows.map(g => [
        Markup.button.callback(`📂 ${g.chat_title} (ID: ${g.chat_id})`, `view_group_${g.chat_id}`)
    ]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

// 点击查看群组 (核心权限检查)
bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const targetChatId = ctx.match[1];

    if (!(await checkAuth(userId))) return ctx.answerCbQuery('无权限');

    // 🔥 关键检查：授权人只能看自己在的群
    const canAccess = await isUserInChat(userId, targetChatId);
    if (!canAccess) {
        return ctx.answerCbQuery('⛔️ 你不在该群组，无法查看记录！', { show_alert: true });
    }

    // 验证通过，显示日志
    await sendLogPage(ctx, 'group', targetChatId, 1);
});

// --- /cksq: 授权管理 (解决问题2: 带取消按钮) ---
bot.command('cksq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔️ 权限不足 (仅老板可用)');
    
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('📂 当前无授权用户。');

    // 生成带取消按钮的列表
    const buttons = res.rows.map(u => [
        Markup.button.callback(
            `❌ 撤销: ${u.user_id} (${u.is_permanent ? '永久' : '限时'})`, 
            `revoke_${u.user_id}`
        )
    ]);

    await ctx.reply('📋 **授权管理面板**\n点击下方按钮可立即撤销权限：', { 
        parse_mode: 'Markdown', 
        ...Markup.inlineKeyboard(buttons) 
    });
});

// 处理撤销回调
bot.action(/revoke_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetId]);
    await ctx.answerCbQuery('已撤销');
    await ctx.editMessageText(`✅ 用户 <code>${targetId}</code> 的授权已取消。`, { parse_mode: 'HTML' });
});

// --- /sc: 删除数据 (解决问题3: 图形化选择) ---
bot.command('sc', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔️ 权限不足');
    
    // 只在私聊使用图形化
    if (ctx.chat.type !== 'private') return ctx.reply('请在私聊使用此指令进行图形化操作。');

    // 列出所有有数据的群
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 数据库是空的，无需清理。');

    const buttons = res.rows.map(g => [
        Markup.button.callback(`🗑️ 删除: ${g.chat_title || '无名群'} (${g.chat_id})`, `pre_wipe_${g.chat_id}`)
    ]);

    await ctx.reply('⚠️ **数据清理模式**\n请点击要清空数据的群组：', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// 预删除确认 (二次确认)
bot.action(/pre_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const chatId = ctx.match[1];
    
    // 查一下名字为了显示友好
    const nameRes = await pool.query('SELECT chat_title FROM messages WHERE chat_id = $1 LIMIT 1', [chatId]);
    const name = nameRes.rows[0]?.chat_title || '该群组';

    await ctx.editMessageText(
        `🛑 **严重警告**\n\n你确定要清空 **${name}** (ID: \`${chatId}\`) 的所有记录吗？\n此操作不可恢复！`, 
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ 确认删除', `do_wipe_${chatId}`)],
                [Markup.button.callback('🔙 取消', 'cancel_action')]
            ])
        }
    );
});

// 执行删除
bot.action(/do_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const chatId = ctx.match[1];
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [chatId]);
    await ctx.editMessageText(`✅ 该群数据已彻底清空。`);
});

bot.action('cancel_action', (ctx) => ctx.deleteMessage());

// --- /sq: 授权逻辑 (保持不变) ---
bot.command('sq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔️ 权限不足');
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 格式错误，请输入数字ID。例: /sq 123456');
    
    global.sqTarget = input;
    await ctx.reply(`🛡️ 正在授权给 ID: \`${input}\`\n请选择时长:`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('1天', 'auth_24'), Markup.button.callback('永久', 'auth_perm')]])
    });
});

bot.action(/auth_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const duration = ctx.match[1];
    const targetId = global.sqTarget;
    let expires = null;
    let perm = duration === 'perm';
    if (!perm) { const d = new Date(); d.setHours(d.getHours()+24); expires = d; }
    await pool.query(`INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`, [targetId, ADMIN_ID, expires, perm]);
    await ctx.editMessageText(`✅ 已授权 ID: ${targetId}`);
});

// --- /rz: 查某人 ---
bot.command('rz', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return ctx.reply('无权限');
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply('用法: /rz ID');
    
    // 监控
    if (ctx.from.id !== ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, `🔔 监控: ID ${ctx.from.id} 正在查 ${input}`).catch(()=>{});
    }

    const isId = /^\d+$/.test(input);
    const param = isId ? input : input.replace('@', '');
    await sendLogPage(ctx, 'user', param, 1);
});

// --- 通用日志翻页显示 ---
async function sendLogPage(ctx, type, target, page) {
    const limit = 10;
    const offset = (page - 1) * limit;
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];

    if (type === 'group') {
        sql += `chat_id = $1`;
        params.push(target);
    } else {
        if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); }
        else { sql += `username = $1`; params.push(target); }
    }
    sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const res = await pool.query(sql, params);
    
    // 标题处理
    let title = type==='group' ? '群组日志' : `用户日志: ${target}`;
    if (type === 'group' && res.rows.length > 0) title = res.rows[0].chat_title;
    
    let text = `📂 <b>${title}</b> (第 ${page} 页)\n\n`;
    if (res.rows.length === 0) text += "本页无记录。";
    
    res.rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const name = l.first_name || '无名';
        if (l.event === 'edit') {
            text += `✏️ <b>${name}</b> 编辑于 ${time}:\n🗑 旧: ${l.original_content}\n🆕 新: ${l.content}\n\n`;
        } else {
            text += `💬 <b>${name}</b> [${time}]:\n${l.content}\n\n`;
        }
    });

    const buttons = [
        [
            Markup.button.callback('⬅️ 上页', `page_${type}_${target}_${page - 1}`),
            Markup.button.callback('⬇️ 导出TXT', `export_${type}_${target}`),
            Markup.button.callback('➡️ 下页', `page_${type}_${target}_${page + 1}`)
        ]
    ];

    if (ctx.callbackQuery) {
        try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }); } catch(e){}
    } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
}

bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => {
    let page = parseInt(ctx.match[3]);
    if (page < 1) page = 1;
    await sendLogPage(ctx, ctx.match[1], ctx.match[2], page);
});

// 导出功能
bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    const type = ctx.match[1];
    const target = ctx.match[2];
    await ctx.answerCbQuery('正在生成...');
    
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else {
        if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); }
        else { sql += `username = $1`; params.push(target); }
    }
    sql += ` ORDER BY created_at DESC LIMIT 5000`;
    const res = await pool.query(sql, params);
    
    let content = `Log Export: ${target}\nTime: ${new Date().toLocaleString()}\n\n`;
    res.rows.forEach(l => content += `[${new Date(l.created_at).toLocaleString()}] ${l.first_name}: ${l.content}\n`);
    await ctx.replyWithDocument({ source: Buffer.from(content), filename: `log_${target}.txt` });
});

// ==========================================
// 6. 启动
// ==========================================
initDB().then(() => {
    bot.launch({ dropPendingUpdates: true }); // 尝试丢弃旧消息防止冲突
    console.log('🚀 机器人终极版启动成功！');
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);
process.once('SIGINT', () => bot.stop('SIGINT'));
