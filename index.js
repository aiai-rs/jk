/**
 * Telegram Logger Bot - 终极权限管理版
 * 功能：409修复 + 严格权限隔离 + 智能ID查询 + XLSX解析
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');
const https = require('https');
const fs = require('fs');

// 尝试加载 xlsx 库，如果没有安装 catch 住防止崩溃，但功能会不可用
let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { console.log('⚠️ 未安装 xlsx 库，Excel 功能将受限。建议运行 npm install xlsx'); }

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

// 统一的大键盘
const MAIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 指令菜单'],
    ['/id ID查询', '/img 转图片模式'],
    ['/cksq 授权管理', '/sc 清空数据']
]).resize().persistent();

// ==========================================
// 2. 提示文案 (严格格式)
// ==========================================
// 针对完全未授权的路人
const NO_AUTH_MSG = `
⛔️ <b>访问被拒绝 (Access Denied)</b>

你还没有获得授权，请授权后再试。
如有疑问请联系管理员 @rrss0
`;

// 针对已授权但乱点按钮的员工
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

async function notifyAdminUnauthorized(ctx) {
    if (ctx.from.id === ADMIN_ID) return;
    const u = ctx.from;
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const content = ctx.message ? (ctx.message.text || '[媒体]') : '[动作]';
    const alertMsg = `🚨 <b>未授权警告</b>\n用户: ${u.first_name} (ID: ${u.id})\n内容: ${content}\n时间: ${time}`;
    try { await bot.telegram.sendMessage(ADMIN_ID, alertMsg, { parse_mode: 'HTML' }); } catch (e) {}
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
    } catch (e) { console.error('Log Error:', e); }
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

// 私聊权限拦截 (第一道门：拦截路人)
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

// --- /ck: 唯一允许普通授权用户使用的功能 ---
bot.command('ck', async (ctx) => {
    // 权限在中件已经检查过是“已授权用户”
    if (ctx.chat.type !== 'private') return sendLogPage(ctx, 'group', ctx.chat.id, 1);

    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 暂无记录。');

    const buttons = res.rows.map(g => [Markup.button.callback(`📂 ${g.chat_title}`, `view_group_${g.chat_id}`)]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

// --- 🔥 管理员专用过滤器 🔥 ---
// 这个中间件会拦截所有非管理员的操作 (除了 /ck)
const adminOnly = async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) {
        // 按照你的要求：只要不是老板，不管有没有授权，点别的按钮一律报错
        return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' });
    }
    await next();
};

// --- /id: 智能查询 (需管理员权限) ---
bot.command('id', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1]; // 获取参数
    let targetId = '';
    let targetName = '';

    // 情况1: 回复某人的消息
    if (ctx.message.reply_to_message) {
        const replyUser = ctx.message.reply_to_message.from;
        targetId = replyUser.id;
        targetName = `${replyUser.first_name} ${replyUser.last_name||''}`;
        await ctx.reply(`🆔 <b>ID查询成功</b>\n\n👤 用户: ${targetName}\n🔢 ID: <code>${targetId}</code>`, { parse_mode: 'HTML' });
        return;
    }

    // 情况2: 输入了用户名 (@username)
    if (input && input.startsWith('@')) {
        const cleanName = input.replace('@', '');
        // 去数据库里搜
        const res = await pool.query('SELECT user_id, first_name FROM messages WHERE username = $1 ORDER BY created_at DESC LIMIT 1', [cleanName]);
        if (res.rows.length > 0) {
            targetId = res.rows[0].user_id;
            targetName = res.rows[0].first_name;
            await ctx.reply(`🆔 <b>数据库检索结果</b>\n\n👤 用户名: ${input}\n👤 昵称: ${targetName}\n🔢 ID: <code>${targetId}</code>\n💡 提示: 复制ID后使用 /sq 进行授权`, { parse_mode: 'HTML' });
        } else {
            await ctx.reply(`❌ 数据库里没找到用户 ${input}，他可能还没在群里发过言。`);
        }
        return;
    }

    // 情况3: 没参数，查自己 (管理员自己查自己)
    await ctx.reply(`🆔 <b>我的信息</b>\n\n👤 ID: <code>${ctx.from.id}</code>\n📍 会话ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});

// --- /img: 图片/文件模式 (需管理员权限) ---
bot.command('img', adminOnly, async (ctx) => {
    fileWaitList.add(ctx.from.id);
    await ctx.reply('🖼️ <b>已进入转图片/预览模式</b>\n\n请发送 <b>.xlsx (Excel)</b> 或 <b>.txt</b> 文件。\n机器人将把它们转换成清晰的视图发给你。\n(发送 /cancel 退出模式)', { parse_mode: 'HTML' });
});

bot.command('cancel', (ctx) => {
    fileWaitList.delete(ctx.from.id);
    ctx.reply('已退出文件模式。');
});

// 处理文件文档 (Excel/Txt)
bot.on('document', async (ctx, next) => {
    if (!fileWaitList.has(ctx.from.id)) return next();
    
    const doc = ctx.message.document;
    const fileName = doc.file_name.toLowerCase();

    // 1. 处理 XLSX Excel 文件
    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        if (!XLSX) return ctx.reply('❌ 服务器未安装 xlsx 组件，无法读取 Excel。');
        
        await ctx.reply('🔄 正在读取 Excel...');
        try {
            const fileLink = await bot.telegram.getFileLink(doc.file_id);
            https.get(fileLink, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', async () => {
                    const buffer = Buffer.concat(chunks);
                    const workbook = XLSX.read(buffer, { type: 'buffer' });
                    const sheetName = workbook.SheetNames[0];
                    const sheet = workbook.Sheets[sheetName];
                    // 转成 JSON 数组
                    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                    
                    if (!data || data.length === 0) return ctx.reply('⚠️ Excel 是空的。');

                    // 构建整齐的表格文本 (模拟图片效果)
                    let textTable = `📊 <b>Excel 预览: ${doc.file_name}</b>\n\n<pre>`;
                    
                    // 只取前 20 行防止消息过长炸裂
                    const previewRows = data.slice(0, 20); 
                    previewRows.forEach(row => {
                        // 将每一行用 | 分隔，模拟表格
                        const line = row.map(cell => String(cell).padEnd(10)).join(' | ');
                        textTable += line + '\n' + '-'.repeat(line.length) + '\n';
                    });
                    textTable += `</pre>`;
                    if (data.length > 20) textTable += `\n⚠️ 仅显示前 20 行，共 ${data.length} 行。`;

                    await ctx.reply(textTable, { parse_mode: 'HTML' });
                    fileWaitList.delete(ctx.from.id); // 处理完自动退出
                });
            });
        } catch (e) {
            console.error(e);
            ctx.reply('❌ 读取 Excel 失败，文件可能损坏。');
        }
        return;
    }

    // 2. 处理 TXT 文件
    if (fileName.endsWith('.txt') || fileName.endsWith('.log')) {
        try {
            const fileLink = await bot.telegram.getFileLink(doc.file_id);
            https.get(fileLink, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', async () => {
                    const preview = data.substring(0, 3500);
                    let msg = `📄 <b>文件预览: ${doc.file_name}</b>\n\n<pre>${preview}</pre>`;
                    if (data.length > 3500) msg += `\n... (内容过长截断)`;
                    await ctx.reply(msg, { parse_mode: 'HTML' });
                    fileWaitList.delete(ctx.from.id);
                });
            });
        } catch (e) { ctx.reply('❌ 读取失败'); }
        return;
    }

    ctx.reply('⚠️ 请发送 .xlsx 或 .txt 文件。');
});

// --- 其他管理员指令 (都加上 adminOnly) ---
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

// 查看群组 (授权用户可用 /ck)
bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const targetChatId = ctx.match[1];
    if (!(await checkAuth(userId))) return ctx.answerCbQuery('无权限');
    if (!(await isUserInChat(userId, targetChatId))) return ctx.answerCbQuery('⛔️ 你没有权限，如有疑问请联系管理员 @rrss0', { show_alert: true });
    await sendLogPage(ctx, 'group', targetChatId, 1);
});

// 管理员Action拦截器
const adminAction = async (ctx, next) => { 
    if (ctx.from.id === ADMIN_ID) await next(); 
    else ctx.answerCbQuery('⛔️ 权限不足 (Permission Denied)', { show_alert: true }); 
};

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

// 🔥🔥🔥 TXT 导出 🔥🔥🔥
bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    const type = ctx.match[1];
    const target = ctx.match[2];
    await ctx.answerCbQuery('生成中...');

    let sql = `SELECT * FROM messages WHERE `;
    let params = [];
    if (type === 'group') { sql += `chat_id = $1`; params.push(target); }
    else { if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); } else { sql += `username = $1`; params.push(target); } }
    sql += ` ORDER BY created_at ASC`; 

    const res = await pool.query(sql, params);
    const rows = res.rows;

    if (rows.length === 0) return ctx.reply('⚠️ 没有数据。');

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
    content += `🔢 总消息数: ${totalCount}\n`;
    content += `✏️ 编辑次数: ${editCount}\n`;
    content += `👥 参与用户: ${uniqueUsers.join(', ')}\n`;
    content += `==================================================\n\n`;

    rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const userLabel = `${l.first_name} (${l.user_id})`;
        if (l.event === 'edit') content += `[${time}] [编辑] ${userLabel}:\n    ❌ 旧: ${l.original_content}\n    ✅ 新: ${l.content}\n--------------------------------------------------\n`;
        else content += `[${time}] [发送] ${userLabel}: ${l.content}\n--------------------------------------------------\n`;
    });

    await ctx.replyWithDocument({ source: Buffer.from(content), filename: `Report_${groupName}.txt` });
});

// ==========================================
// 8. 启动
// ==========================================
initDB().then(async () => {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch({ dropPendingUpdates: true, polling: { timeout: 30, limit: 100 } });
        console.log('🚀 机器人终极版启动成功！');
    } catch (e) { console.error(e); }
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);
const stopBot = (s) => { bot.stop(s); pool.end(); process.exit(0); };
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
