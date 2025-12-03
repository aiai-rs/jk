/**
 * Telegram Logger Bot - 终极专业版
 * 功能：409修复 + 权限隔离 + 高级TXT导出 + ID查询 + 文件智能预览
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');
const https = require('https'); // 用于下载文件

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

// 全局状态：记录谁正在等待发送文件
const fileWaitList = new Set();

// 统一的大键盘 (新增 ID 和 图片 功能)
const MAIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 指令菜单'],
    ['/id 我的ID', '/img 转图片模式'],
    ['/cksq 授权管理', '/sc 清空数据']
]).resize().persistent();

// ==========================================
// 2. 提示文案
// ==========================================
const NO_AUTH_MSG = `
⛔️ <b>访问被拒绝 (Access Denied)</b>

你还没有获得授权，请授权后再试。
如有疑问请联系管理员 @rrss0
`;

const LOW_PERM_MSG = `
⛔️ <b>权限不足 (Permission Denied)</b>

你没有授权，请授权后再试。
如有疑问请联系管理员 @rrss0
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

// 报警系统
async function notifyAdminUnauthorized(ctx) {
    if (ctx.from.id === ADMIN_ID) return;
    const u = ctx.from;
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const content = ctx.message ? (ctx.message.text || '[媒体]') : '[动作]';
    const alertMsg = `🚨 <b>未授权警告</b>\n用户: ${u.first_name} (ID: ${u.id})\n内容: ${content}\n时间: ${time}`;
    try { await bot.telegram.sendMessage(ADMIN_ID, alertMsg, { parse_mode: 'HTML' }); } catch (e) {}
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

async function isUserInChat(userId, chatId) {
    if (userId === ADMIN_ID) return true;
    try {
        const member = await bot.telegram.getChatMember(chatId, userId);
        return !(member.status === 'left' || member.status === 'kicked');
    } catch (e) { return false; }
}

// ==========================================
// 5. 中间件
// ==========================================

// 记录群消息
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

// 私聊权限拦截
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) {
        const userId = ctx.from.id;
        const isAuth = await checkAuth(userId);
        if (!isAuth) {
            await notifyAdminUnauthorized(ctx);
            await ctx.reply(NO_AUTH_MSG, { parse_mode: 'HTML' });
            return; 
        }
    }
    await next();
});

// ==========================================
// 6. 指令与功能
// ==========================================

// --- /start ---
bot.start(async (ctx) => {
    await ctx.reply('👋 欢迎使用，键盘已激活。', MAIN_KEYBOARD);
});

// --- /id: 查询ID ---
bot.command('id', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    await ctx.reply(`🆔 <b>用户信息查询</b>\n\n👤 <b>你的ID:</b> <code>${userId}</code>\n📍 <b>当前会话ID:</b> <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

// --- /img: 图片模式 (文件处理) ---
bot.command('img', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return;
    fileWaitList.add(ctx.from.id);
    await ctx.reply('🖼️ <b>已进入文件处理模式</b>\n\n请发送一个 <b>TXT 文件</b>，机器人将读取内容并整理显示。\n(发送 /cancel 退出模式)', { parse_mode: 'HTML' });
});

bot.command('cancel', (ctx) => {
    fileWaitList.delete(ctx.from.id);
    ctx.reply('已退出文件模式。');
});

// 处理文件文档
bot.on('document', async (ctx, next) => {
    if (!fileWaitList.has(ctx.from.id)) return next();
    
    const doc = ctx.message.document;
    // 简单检查后缀
    if (!doc.file_name.endsWith('.txt') && !doc.file_name.endsWith('.log')) {
        return ctx.reply('⚠️ 目前仅支持 .txt 或 .log 文本文件预览。');
    }

    try {
        const fileLink = await bot.telegram.getFileLink(doc.file_id);
        
        // 下载文件内容
        https.get(fileLink, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', async () => {
                // 如果内容太长，截取前4000字
                const preview = data.substring(0, 3500);
                const isCut = data.length > 3500;
                
                let msg = `📄 <b>文件预览: ${doc.file_name}</b>\n`;
                msg += `📏 大小: ${(doc.file_size/1024).toFixed(2)} KB\n\n`;
                msg += `<pre>${preview}</pre>`;
                if (isCut) msg += `\n... (内容过长，仅显示前 3500 字)`;

                await ctx.reply(msg, { parse_mode: 'HTML' });
                // 退出模式
                fileWaitList.delete(ctx.from.id);
            });
        }).on('error', (e) => {
            ctx.reply('❌ 文件读取失败');
        });
    } catch (e) {
        ctx.reply('❌ 处理出错');
    }
});

// --- /ck: 查日志 ---
bot.command('ck', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return;
    if (ctx.chat.type !== 'private') return sendLogPage(ctx, 'group', ctx.chat.id, 1);

    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 暂无记录。');

    const buttons = res.rows.map(g => [Markup.button.callback(`📂 ${g.chat_title}`, `view_group_${g.chat_id}`)]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

// --- 管理员专用拦截 ---
const adminOnly = async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' });
    await next();
};

bot.command('bz', adminOnly, (ctx) => ctx.reply('管理员菜单:\n/ck, /rz, /sq, /cksq, /sc'));
bot.command('cksq', adminOnly, async (ctx) => {
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('无授权。');
    const buttons = res.rows.map(u => [Markup.button.callback(`❌ 撤销: ${u.user_id}`, `revoke_${u.user_id}`)]);
    await ctx.reply('授权管理:', Markup.inlineKeyboard(buttons));
});
bot.command('sc', adminOnly, async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('空数据库。');
    const buttons = res.rows.map(g => [Markup.button.callback(`🗑️ 删除: ${g.chat_title}`, `pre_wipe_${g.chat_id}`)]);
    await ctx.reply('选择清空群组:', Markup.inlineKeyboard(buttons));
});
bot.command('sq', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 格式: /sq ID');
    global.sqTarget = input;
    const btns = [
        [Markup.button.callback('1小时', 'auth_1h'), Markup.button.callback('1天', 'auth_1d'), Markup.button.callback('永久', 'auth_perm')]
    ];
    await ctx.reply(`🛡️ 授权 ID: ${input}`, Markup.inlineKeyboard(btns));
});
bot.command('rz', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (input) await sendLogPage(ctx, 'user', input.replace('@', ''), 1);
});

// ==========================================
// 7. 回调与导出逻辑
// ==========================================

bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const targetChatId = ctx.match[1];
    if (!(await checkAuth(userId))) return ctx.answerCbQuery('无权限');
    if (!(await isUserInChat(userId, targetChatId))) return ctx.answerCbQuery('⛔️ 你没有权限，如有疑问请联系管理员 @rrss0', { show_alert: true });
    await sendLogPage(ctx, 'group', targetChatId, 1);
});

// 管理员Action
const adminAction = async (ctx, next) => { if (ctx.from.id === ADMIN_ID) await next(); else ctx.answerCbQuery('无权限'); };
bot.action(/auth_(.+)/, adminAction, async (ctx) => {
    const type = ctx.match[1], target = global.sqTarget;
    let expires = new Date(), perm = false;
    if (type === '1h') expires.setHours(expires.getHours()+1);
    else if (type === '1d') expires.setDate(expires.getDate()+1);
    else perm = true;
    await pool.query(`INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`, [target, ADMIN_ID, perm?null:expires, perm]);
    await ctx.editMessageText(`✅ 已授权 ${target}`);
});
bot.action(/revoke_(\d+)/, adminAction, async (ctx) => {
    await pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [ctx.match[1]]);
    await ctx.editMessageText('已撤销。');
});
bot.action(/pre_wipe_(-?\d+)/, adminAction, async (ctx) => {
    const id = ctx.match[1];
    await ctx.editMessageText(`⚠️ 确认清空 ${id}?`, Markup.inlineKeyboard([[Markup.button.callback('✅ 确认', `do_wipe_${id}`)],[Markup.button.callback('取消', 'cancel')]]));
});
bot.action(/do_wipe_(-?\d+)/, adminAction, async (ctx) => {
    await pool.query('DELETE FROM messages WHERE chat_id=$1', [ctx.match[1]]);
    await ctx.editMessageText('已清空。');
});
bot.action('cancel', (ctx) => ctx.deleteMessage());

// 日志翻页
async function sendLogPage(ctx, type, target, page) {
    const limit = 10, offset = (page - 1) * limit;
    let sql = `SELECT * FROM messages WHERE `, params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else { if(/^\d+$/.test(target)) {sql+=`user_id=$1`;params.push(target);} else {sql+=`username=$1`;params.push(target);} }
    sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    
    const res = await pool.query(sql, params);
    let title = type==='group'?'群组':`用户: ${target}`;
    if (type==='group' && res.rows.length>0) title = res.rows[0].chat_title;
    
    let text = `📂 <b>${title}</b> (第 ${page} 页)\n\n`;
    if(res.rows.length===0) text+='无记录';
    res.rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
        text += l.event==='edit' ? `✏️ <b>${l.first_name}</b> [${time}]:\n旧: ${l.original_content}\n新: ${l.content}\n\n` : `💬 <b>${l.first_name}</b> [${time}]:\n${l.content}\n\n`;
    });
    
    const btns = [[Markup.button.callback('⬅️', `page_${type}_${target}_${page-1}`), Markup.button.callback('⬇️ 导出TXT', `export_${type}_${target}`), Markup.button.callback('➡️', `page_${type}_${target}_${page+1}`)]];
    if(ctx.callbackQuery) try{await ctx.editMessageText(text,{parse_mode:'HTML',...Markup.inlineKeyboard(btns)})}catch(e){}
    else await ctx.reply(text,{parse_mode:'HTML',...Markup.inlineKeyboard(btns)});
}

bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => {
    let p = parseInt(ctx.match[3]); if(p<1) p=1;
    await sendLogPage(ctx, ctx.match[1], ctx.match[2], p);
});

// 🔥🔥🔥 超级导出功能 (核心修改) 🔥🔥🔥
bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    const type = ctx.match[1];
    const target = ctx.match[2];
    await ctx.answerCbQuery('正在生成详细报告...');

    // 1. 获取所有数据
    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else { if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); } else { sql += `username = $1`; params.push(target); } }
    sql += ` ORDER BY created_at ASC`; // 导出时按时间正序，方便阅读

    const res = await pool.query(sql, params);
    const rows = res.rows;

    if (rows.length === 0) return ctx.reply('⚠️ 没有数据可导出。');

    // 2. 计算统计数据
    const groupName = rows[0].chat_title || '未知群组';
    const totalCount = rows.length;
    const editCount = rows.filter(r => r.event === 'edit').length;
    // 获取参与用户列表 (去重)
    const uniqueUsers = [...new Set(rows.map(r => `${r.first_name}(${r.user_id})`))];
    const userListStr = uniqueUsers.join(', ');
    const exportTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 3. 构建精美头部
    let content = `==================================================\n`;
    content += `📊 群组日志详细报告\n`;
    content += `==================================================\n`;
    content += `📁 群组名称: ${groupName}\n`;
    content += `🆔 群组 ID : ${target}\n`;
    content += `📅 导出时间: ${exportTime}\n`;
    content += `🔢 总消息数: ${totalCount} 条\n`;
    content += `✏️ 编辑次数: ${editCount} 次\n`;
    content += `👥 参与用户: ${userListStr}\n`;
    content += `⚠️ 说明: 因官方限制，本机器人无法记录已删除的消息。\n`;
    content += `==================================================\n\n`;
    content += `[详细记录开始]\n\n`;

    // 4. 构建正文
    rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const name = l.first_name || '无名';
        const userLabel = `${name} (${l.user_id})`;

        if (l.event === 'edit') {
            content += `[${time}] [编辑] ${userLabel}:\n    ❌ 旧内容: ${l.original_content}\n    ✅ 新内容: ${l.content}\n`;
        } else {
            content += `[${time}] [发送] ${userLabel}: ${l.content}\n`;
        }
        content += `--------------------------------------------------\n`;
    });

    // 5. 发送文件
    const buffer = Buffer.from(content, 'utf-8');
    await ctx.replyWithDocument({
        source: buffer,
        filename: `Report_${groupName}_${new Date().toISOString().split('T')[0]}.txt`
    });
});

// ==========================================
// 8. 启动
// ==========================================
initDB().then(async () => {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch({ dropPendingUpdates: true, polling: { timeout: 30, limit: 100 } });
        console.log('🚀 机器人专业版启动成功！');
    } catch (e) { console.error(e); }
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);
const stopBot = (s) => { bot.stop(s); pool.end(); process.exit(0); };
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
