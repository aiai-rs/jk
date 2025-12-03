require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');
const https = require('https');

let XLSX = null;
try {
    XLSX = require('xlsx');
} catch (e) {
    console.log('XLSX library not found');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !ADMIN_ID || !DATABASE_URL) {
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const fileCache = new Map();
const fileWaitList = new Set();
let globalSqTarget = null;

const MAIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 指令菜单'],
    ['/id ID查询', '/img 转图片模式'],
    ['/cksq 授权管理', '/sj 数据检测']
]).resize().persistent();

const NO_AUTH_MSG = `
⛔️ <b>访问被拒绝 (Access Denied)</b>

你还没有获得授权，请授权后再试。
如有疑问请联系管理员 @rrss0
`;

const LOW_PERM_MSG = `
⛔️ <b>权限不足 (Permission Denied)</b>

你没有操作该功能的权限，请联系管理员。
如有疑问请联系管理员 @rrss0
`;

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
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
    }
}

async function notifyAdmin(title, ctx, extraInfo = '') {
    if (ctx.from.id === ADMIN_ID) return;

    const u = ctx.from;
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    
    const msg = `🚨 <b>${title}</b>\n\n` +
                `👤 <b>用户:</b> ${u.first_name} ${u.last_name || ''}\n` +
                `📛 <b>用户名:</b> @${u.username || '无'}\n` +
                `🆔 <b>ID:</b> <code>${u.id}</code>\n` +
                `⏰ <b>时间:</b> ${time}\n` +
                `${extraInfo}`;
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' });
    } catch (e) {
        console.error(e);
    }
}

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
    } catch (e) {
        console.error(e);
    }
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

async function isUserInChat(userId, chatId) {
    if (userId === ADMIN_ID) return true;
    try {
        const member = await bot.telegram.getChatMember(chatId, userId);
        return !(member.status === 'left' || member.status === 'kicked');
    } catch (e) {
        return false;
    }
}

bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private' && ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.reply('⛔️ 你没有权限 ⛔️');
        }
    }
    await next();
});

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

bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) {
        const userId = ctx.from.id;
        const isAuth = await checkAuth(userId);
        if (!isAuth) {
            await notifyAdmin('未授权访问拦截', ctx, `💬 尝试内容: ${ctx.message.text || '非文本'}`);
            await ctx.reply(NO_AUTH_MSG, { parse_mode: 'HTML' });
            return;
        }
    }
    await next();
});

bot.start(async (ctx) => {
    await ctx.reply('👋 欢迎使用系统，键盘已激活。', MAIN_KEYBOARD);
});

bot.command('ck', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return sendLogPage(ctx, 'group', ctx.chat.id, 1);
    }

    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 数据库暂无记录。');

    const buttons = res.rows.map(g => [
        Markup.button.callback(`📂 ${g.chat_title}`, `view_group_${g.chat_id}`)
    ]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

const adminOnly = async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) {
        const command = ctx.message.text.split(' ')[0];
        await notifyAdmin('⚠️ 敏感操作警告', ctx, `🔥 <b>行为:</b> 试图执行 ${command}\n该用户已授权，但权限不足。`);
        return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' });
    }
    await next();
};

bot.command('bz', adminOnly, async (ctx) => {
    const text = `📜 **管理员指令菜单**
    
/ck - 查看群组聊天记录
/id - 查询自己或别人的ID
/img - 文件转图片预览模式
/sq - 给用户授权访问机器人
/cksq - 查看和撤销已授权用户
/sj - 数据库检测与一键重置
/sc - 选择删除某个群的记录
/qc - 强制清空所有数据库`;
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('sj', adminOnly, async (ctx) => {
    const res = await pool.query('SELECT COUNT(*) FROM messages');
    const count = parseInt(res.rows[0].count);
    
    if (count === 0) {
        return ctx.reply('✅ 数据库是空的，像新的一样。');
    }

    await ctx.reply(
        `📊 **数据库状态检测**\n\n当前共有 **${count}** 条发言数据。\n是否执行重置操作？`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔥 永久删除 (重置为新)', 'do_reset_db')],
                [Markup.button.callback('🔙 取消', 'cancel_action')]
            ])
        }
    );
});

bot.command('sc', adminOnly, async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.reply('请私聊操作。');
    
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 数据库是空的。');

    const buttons = res.rows.map(g => [
        Markup.button.callback(`🗑️ 删除: ${g.chat_title}`, `pre_wipe_${g.chat_id}`)
    ]);
    await ctx.reply('⚠️ **数据清理模式**\n请选择要清空的群组:', Markup.inlineKeyboard(buttons));
});

bot.command('qc', adminOnly, async (ctx) => {
    await ctx.reply(
        `🧨 **严重警告** 🧨\n\n此指令将清空所有数据！是否继续？`, 
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('☠️ 确认清空所有数据', 'do_wipe_all')],
                [Markup.button.callback('🔙 取消', 'cancel_action')]
            ])
        }
    );
});

bot.command('sq', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 格式错误。正确用法: /sq 数字ID');
    
    globalSqTarget = input;
    
    const timeButtons = [
        [Markup.button.callback('1小时', 'auth_1h'), Markup.button.callback('3小时', 'auth_3h'), Markup.button.callback('6小时', 'auth_6h')],
        [Markup.button.callback('1天', 'auth_1d'), Markup.button.callback('3天', 'auth_3d'), Markup.button.callback('永久', 'auth_perm')]
    ];

    await ctx.reply(`🛡️ 正在授权给 ID: \`${input}\`\n请选择有效时长:`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(timeButtons)
    });
});

bot.command('cksq', adminOnly, async (ctx) => {
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('📂 无授权用户。');

    const buttons = res.rows.map(u => [
        Markup.button.callback(`❌ 撤销: ${u.user_id} (${u.is_permanent ? '永久' : '限时'})`, `revoke_${u.user_id}`)
    ]);
    await ctx.reply('📋 授权管理列表:', Markup.inlineKeyboard(buttons));
});

bot.command('id', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    
    if (ctx.message.reply_to_message) {
        const u = ctx.message.reply_to_message.from;
        return ctx.reply(`🆔 <b>ID查询结果</b>\n\n👤 用户: ${u.first_name}\n🔢 ID: <code>${u.id}</code>`, { parse_mode: 'HTML' });
    }

    if (input && input.startsWith('@')) {
        const username = input.replace('@', '');
        const res = await pool.query('SELECT user_id, first_name FROM messages WHERE username = $1 ORDER BY created_at DESC LIMIT 1', [username]);
        if (res.rows.length > 0) {
            return ctx.reply(`🆔 <b>数据库检索结果</b>\n\n👤 用户名: ${input}\n👤 昵称: ${res.rows[0].first_name}\n🔢 ID: <code>${res.rows[0].user_id}</code>`, { parse_mode: 'HTML' });
        } else {
            return ctx.reply(`❌ 未找到用户 ${input} 的记录。`);
        }
    }

    await ctx.reply(`🆔 <b>我的信息</b>\n\n👤 ID: <code>${ctx.from.id}</code>\n📍 会话ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});

bot.command('img', adminOnly, async (ctx) => {
    fileWaitList.add(ctx.from.id);
    await ctx.reply('🖼️ <b>已进入文件预览模式</b>\n\n请发送 <b>.xlsx (Excel)</b> 或 <b>.txt</b> 文件。\n机器人将自动解析并支持翻页查看。\n(发送 /cancel 退出模式)', { parse_mode: 'HTML' });
});

bot.command('cancel', (ctx) => {
    fileWaitList.delete(ctx.from.id);
    ctx.reply('已退出操作模式。');
});

bot.on('document', async (ctx, next) => {
    if (!fileWaitList.has(ctx.from.id)) return next();
    
    const doc = ctx.message.document;
    const fileName = doc.file_name.toLowerCase();
    
    let fullText = '';
    
    try {
        await ctx.reply('⏳ 正在下载并解析文件...');
        const fileLink = await bot.telegram.getFileLink(doc.file_id);
        
        const downloadPromise = new Promise((resolve, reject) => {
            https.get(fileLink, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
        });
        
        const buffer = await downloadPromise;

        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            if (!XLSX) return ctx.reply('❌ 无法处理 Excel (缺少 xlsx 库)。');
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            
            jsonData.forEach(row => {
                const line = row.map(cell => String(cell).padEnd(10)).join(' | ');
                fullText += line + '\n' + '-'.repeat(Math.min(line.length, 60)) + '\n';
            });
            
        } else if (fileName.endsWith('.txt') || fileName.endsWith('.log')) {
            fullText = buffer.toString('utf-8');
        } else {
            return ctx.reply('⚠️ 仅支持 .txt, .log 或 .xlsx 文件。');
        }

        if (!fullText.trim()) return ctx.reply('⚠️ 文件内容为空。');

        const pageSize = 3000;
        const totalPages = Math.ceil(fullText.length / pageSize);
        
        fileCache.set(ctx.from.id, { 
            content: fullText, 
            fileName: doc.file_name, 
            totalPages: totalPages 
        });

        await sendFilePage(ctx, ctx.from.id, 1);
        fileWaitList.delete(ctx.from.id);

    } catch (e) {
        console.error(e);
        ctx.reply('❌ 文件处理失败，可能是文件过大或格式错误。');
    }
});

async function sendFilePage(ctx, userId, page) {
    const cache = fileCache.get(userId);
    if (!cache) return ctx.reply('⚠️ 文件预览会话已过期，请重新上传。');

    const pageSize = 3000;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    
    let chunk = cache.content.substring(start, end);
    chunk = chunk.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const msgText = `📄 <b>${cache.fileName}</b>\n` +
                    `页码: ${page} / ${cache.totalPages}\n\n` +
                    `<pre>${chunk}</pre>`;

    const buttons = [];
    if (page > 1) {
        buttons.push(Markup.button.callback('⬅️ 上一页', `fpage_${page - 1}`));
    }
    buttons.push(Markup.button.callback(`${page}/${cache.totalPages}`, 'noop'));
    if (page < cache.totalPages) {
        buttons.push(Markup.button.callback('下一页 ➡️', `fpage_${page + 1}`));
    }

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(msgText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([buttons]) });
        } else {
            await ctx.reply(msgText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([buttons]) });
        }
    } catch (e) {
        console.error(e);
    }
}

bot.action(/fpage_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await sendFilePage(ctx, ctx.from.id, page);
});

bot.action('do_wipe_all', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        await pool.query('TRUNCATE TABLE messages');
        await ctx.editMessageText('☠️ <b>数据库已彻底重置。</b>\n所有记录已化为灰烬。', { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply('❌ 删除失败: ' + e.message);
    }
});

bot.action('do_reset_db', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        await pool.query('TRUNCATE TABLE messages');
        await ctx.editMessageText('✅ <b>操作成功</b>\n数据库已恢复为全新状态。', { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply('❌ 操作失败: ' + e.message);
    }
});

bot.action(/pre_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const id = ctx.match[1];
    await ctx.editMessageText(`⚠️ 确认清空 ID \`${id}\` 的记录吗？不可恢复！`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ 确认', `do_wipe_${id}`)],
            [Markup.button.callback('🔙 取消', 'cancel_action')]
        ])
    });
});

bot.action(/do_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [ctx.match[1]]);
    await ctx.editMessageText(`✅ 该群数据已清空。`);
});

bot.action(/auth_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('无权限');
    
    const type = ctx.match[1];
    const targetId = globalSqTarget;
    let expires = new Date();
    let isPerm = false;
    let text = '';

    switch(type) {
        case '1h': expires.setHours(expires.getHours() + 1); text = '1小时'; break;
        case '3h': expires.setHours(expires.getHours() + 3); text = '3小时'; break;
        case '6h': expires.setHours(expires.getHours() + 6); text = '6小时'; break;
        case '1d': expires.setDate(expires.getDate() + 1); text = '1天'; break;
        case '3d': expires.setDate(expires.getDate() + 3); text = '3天'; break;
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

bot.action(/revoke_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [ctx.match[1]]);
    await ctx.editMessageText('✅ 授权已撤销。');
});

bot.action('cancel_action', (ctx) => ctx.deleteMessage());
bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const targetChatId = ctx.match[1];

    if (!(await checkAuth(userId))) return ctx.answerCbQuery('无权限');

    const canAccess = await isUserInChat(userId, targetChatId);
    if (!canAccess) {
        return ctx.answerCbQuery('⛔️ 你没有权限，如有疑问请联系管理员 @rrss0', { show_alert: true });
    }

    await sendLogPage(ctx, 'group', targetChatId, 1);
});

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
    
    let title = type === 'group' ? '群组日志' : `用户日志: ${target}`;
    if (type === 'group' && res.rows.length > 0) title = res.rows[0].chat_title;
    
    let text = `📂 <b>${title}</b> (第 ${page} 页)\n\n`;
    if (res.rows.length === 0) text += "本页无记录。";
    
    res.rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const name = l.first_name || '无名';
        if (l.event === 'edit') {
            text += `✏️ <b>${name}</b> [${time}]:\n❌ 旧: ${l.original_content}\n✅ 新: ${l.content}\n\n`;
        } else {
            text += `💬 <b>${name}</b> [${time}]:\n${l.content}\n\n`;
        }
    });

    const buttons = [[
        Markup.button.callback('⬅️ 上页', `page_${type}_${target}_${page - 1}`),
        Markup.button.callback('⬇️ 导出TXT', `export_${type}_${target}`),
        Markup.button.callback('下页 ➡️', `page_${type}_${target}_${page + 1}`)
    ]];

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

bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    const type = ctx.match[1];
    const target = ctx.match[2];
    await ctx.answerCbQuery('正在生成详细报告...');

    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else { if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); } else { sql += `username = $1`; params.push(target); } }
    sql += ` ORDER BY created_at ASC`; 

    const res = await pool.query(sql, params);
    const rows = res.rows;

    if (rows.length === 0) return ctx.reply('⚠️ 没有数据可导出。');

    const groupName = rows[0].chat_title || '未知群组';
    const totalCount = rows.length;
    const editCount = rows.filter(r => r.event === 'edit').length;
    const uniqueUsers = [...new Set(rows.map(r => `${r.first_name}(${r.user_id})`))];
    const exportTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    let content = `==================================================\n`;
    content += `📊 群组日志详细报告\n`;
    content += `==================================================\n`;
    content += `📁 群组名称: ${groupName}\n`;
    content += `🆔 群组 ID : ${target}\n`;
    content += `📅 导出时间: ${exportTime}\n`;
    content += `🔢 总消息数: ${totalCount} 条\n`;
    content += `✏️ 编辑次数: ${editCount} 次\n`;
    content += `👥 参与用户: ${uniqueUsers.join(', ')}\n`;
    content += `⚠️ 说明: 因官方限制，无法记录已删除消息。\n`;
    content += `==================================================\n\n`;
    content += `[记录开始]\n\n`;

    rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const userLabel = `${l.first_name} (${l.user_id})`;

        if (l.event === 'edit') {
            content += `[${time}] [编辑] ${userLabel}:\n    ❌ 旧内容: ${l.original_content}\n    ✅ 新内容: ${l.content}\n`;
        } else {
            content += `[${time}] [发送] ${userLabel}: ${l.content}\n`;
        }
        content += `--------------------------------------------------\n`;
    });

    await ctx.replyWithDocument({
        source: Buffer.from(content),
        filename: `Report_${target}_${Date.now()}.txt`
    });
});

initDB().then(async () => {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        await bot.launch({
            dropPendingUpdates: true,
            polling: {
                timeout: 30,
                limit: 100
            }
        });
        console.log('Bot started successfully');
    } catch (e) {
        console.error(e);
    }
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('System Online');
}).listen(PORT);

const stopBot = (signal) => {
    bot.stop(signal);
    pool.end();
    process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
