/**
 * Telegram Logger Bot - 全场景适配版
 * * 更新内容：
 * 1. /ck 双模式：群里查当前，私聊查所有
 * 2. 键盘分级：管理员全功能，授权人仅查看
 * 3. 授权人也能使用永久键盘
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');

// ==========================================
// 1. 配置区域
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !ADMIN_ID || !DATABASE_URL) {
    console.error('❌ 错误：环境变量缺失。');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- 键盘定义 ---

// 1. 老板专用键盘 (全功能)
const ADMIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 所有指令'],
    ['/cksq 管理授权', '/sc 清空数据']
]).resize();

// 2. 被授权人专用键盘 (仅查看)
const AUTH_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志']
]).resize();

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
// 3. 核心工具函数
// ==========================================

// 记录日志
async function logMessage(ctx, eventType, oldContent = null) {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg) return;
    if (ctx.chat.type === 'private') return; // 私聊不记录

    const content = msg.text || msg.caption || `[媒体消息]`;
    const chatTitle = msg.chat.title || '未知群组';

    try {
        await pool.query(
            `INSERT INTO messages (msg_id, chat_id, chat_title, user_id, username, first_name, content, event, original_content)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [msg.message_id, msg.chat.id, chatTitle, msg.from.id, msg.from.username, msg.from.first_name, content, eventType, oldContent]
        );
    } catch (e) {
        console.error('写入失败:', e);
    }
}

// 获取旧内容
async function getOldContent(msgId, chatId) {
    const res = await pool.query(
        `SELECT content FROM messages WHERE msg_id = $1 AND chat_id = $2 AND event = 'send' ORDER BY id DESC LIMIT 1`,
        [msgId, chatId]
    );
    return res.rows[0] ? res.rows[0].content : '[未知历史]';
}

// 检查权限
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

// 生成日志文本
function generateLogText(rows, title, page) {
    if (rows.length === 0) return `📭 ${title} (第 ${page} 页)\n暂无更多记录。`;
    
    let text = `📂 <b>${title}</b> (页 ${page})\n\n`;
    rows.forEach(l => {
        const time = new Date(l.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const name = l.first_name || '无名';
        
        if (l.event === 'edit') {
            text += `✏️ <b>${name}</b> 编辑于 ${time}:\n🗑 旧: ${l.original_content}\n🆕 新: ${l.content}\n\n`;
        } else {
            text += `💬 <b>${name}</b> 发表于 ${time}:\n${l.content}\n\n`;
        }
    });
    return text;
}

// 生成翻页按钮
function generateControls(type, targetId, currentPage) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('⬅️ 上页', `page_${type}_${targetId}_${currentPage - 1}`),
            Markup.button.callback('⬇️ 导出TXT', `export_${type}_${targetId}`),
            Markup.button.callback('➡️ 下页', `page_${type}_${targetId}_${currentPage + 1}`)
        ]
    ]);
}

// ==========================================
// 4. 中间件 (日志记录 & 自动回复)
// ==========================================

// A. 记录所有群消息 (第一优先)
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

// B. 私聊自动回复 + 键盘分发
bot.use(async (ctx, next) => {
    // 仅处理私聊文本消息，且不以 / 开头
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
        const userId = ctx.from.id;

        // 1. 如果是老板
        if (userId === ADMIN_ID) {
            await ctx.reply('👮‍♂️ 老板我在！指令系统就绪。', ADMIN_KEYBOARD);
            return;
        }

        // 2. 如果是被授权人
        if (await checkAuth(userId)) {
            await ctx.reply('✅ 您好，您已获授权。请使用下方按钮查看日志。', AUTH_KEYBOARD);
            return;
        }

        // 3. 闲杂人等
        // 不回话，或者回一句无权限
        // await ctx.reply('⛔️ 无权访问。'); 
    }
    await next();
});

// ==========================================
// 5. 指令处理
// ==========================================

// --- /bz: 显示指令 (仅老板) ---
bot.command('bz', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.reply(
        `📜 **老板指令手册**\n\n` +
        `/ck - 查日志 (自动识别群/私聊)\n` +
        `/rz ID - 查特定人的记录\n` +
        `/sq ID - 授权他人\n` +
        `/cksq - 查看授权名单\n` +
        `/sc - 清空数据`, 
        { parse_mode: 'Markdown', ...ADMIN_KEYBOARD }
    );
});

// --- /ck: 查看日志 (双模式核心) ---
bot.command('ck', async (ctx) => {
    // 1. 鉴权
    if (!(await checkAuth(ctx.from.id))) return ctx.reply('无权访问。');

    // 2. 场景判断
    // 👉 场景 A: 在群组里使用 -> 直接显示本群记录
    if (ctx.chat.type !== 'private') {
        const page = 1;
        const res = await pool.query(
            `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10 OFFSET 0`,
            [ctx.chat.id]
        );
        const text = generateLogText(res.rows, `群组日志: ${ctx.chat.title}`, page);
        return ctx.reply(text, { 
            parse_mode: 'HTML', 
            ...generateControls('group', ctx.chat.id, page) 
        });
    }

    // 👉 场景 B: 在私聊使用 -> 列出所有群组供选择
    // 无论是老板还是授权人，私聊 /ck 都是这个逻辑
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    
    if (res.rows.length === 0) return ctx.reply('📭 数据库空空如也，没有任何群组记录。');

    const buttons = res.rows.map(g => [
        Markup.button.callback(`📂 ${g.chat_title}`, `view_group_${g.chat_id}`)
    ]);

    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

// 私聊点击群组按钮后的处理
bot.action(/view_group_(-?\d+)/, async (ctx) => {
    // 再次鉴权
    if (!(await checkAuth(ctx.from.id))) return ctx.answerCbQuery('权限已过期');

    const targetChatId = ctx.match[1];
    const page = 1;

    // 查这个群的第一页
    const res = await pool.query(
        `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10 OFFSET 0`,
        [targetChatId]
    );

    // 获取群名(为了显示好看)
    const titleRes = await pool.query('SELECT chat_title FROM messages WHERE chat_id = $1 LIMIT 1', [targetChatId]);
    const title = titleRes.rows[0] ? titleRes.rows[0].chat_title : '未知群组';

    const text = generateLogText(res.rows, `群组日志: ${title}`, page);
    
    await ctx.editMessageText(text, { 
        parse_mode: 'HTML', 
        ...generateControls('group', targetChatId, page) 
    });
});

// --- /rz: 查某人 ---
bot.command('rz', async (ctx) => {
    if (!(await checkAuth(ctx.from.id))) return;
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply('用法: /rz ID');

    // 监控通知
    if (ctx.from.id !== ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, `🔔 监控: ID ${ctx.from.id} 正在查 ${input}`).catch(()=>{});
    }

    // 简单判断是ID还是用户名
    let isId = /^\d+$/.test(input);
    let sql = `SELECT * FROM messages WHERE ${isId ? 'user_id' : 'username'} = $1 ORDER BY created_at DESC LIMIT 10 OFFSET 0`;
    let param = isId ? input : input.replace('@', '');

    const res = await pool.query(sql, [param]);
    const text = generateLogText(res.rows, `用户日志: ${input}`, 1);
    await ctx.reply(text, { parse_mode: 'HTML', ...generateControls('user', param, 1) });
});

// --- 翻页通用逻辑 ---
bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => {
    const type = ctx.match[1];
    const target = ctx.match[2];
    let page = parseInt(ctx.match[3]);
    if (page < 1) page = 1;
    const offset = (page - 1) * 10;

    let sql = `SELECT * FROM messages WHERE `;
    let params = [];

    if (type === 'group') {
        sql += `chat_id = $1`;
        params.push(target);
    } else {
        if (/^\d+$/.test(target)) { sql += `user_id = $1`; params.push(target); }
        else { sql += `username = $1`; params.push(target); }
    }
    sql += ` ORDER BY created_at DESC LIMIT 10 OFFSET ${offset}`;

    const res = await pool.query(sql, params);
    const title = type === 'group' ? `群组日志` : `用户日志: ${target}`;
    
    try {
        await ctx.editMessageText(generateLogText(res.rows, title, page), {
            parse_mode: 'HTML',
            ...generateControls(type, target, page)
        });
    } catch (e) { await ctx.answerCbQuery('到底了'); }
});

// --- 导出 TXT ---
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
    sql += ` ORDER BY created_at DESC LIMIT 1000`;

    const res = await pool.query(sql, params);
    if (res.rows.length === 0) return ctx.reply('无数据。');

    let content = `导出日志: ${target}\n时间: ${new Date().toLocaleString()}\n\n`;
    res.rows.forEach(l => {
        content += `[${new Date(l.created_at).toLocaleString()}] ${l.first_name}: ${l.content}\n`;
        if(l.event==='edit') content += `   (旧: ${l.original_content})\n`;
    });

    await ctx.replyWithDocument({ source: Buffer.from(content), filename: `log_${target}.txt` });
});

// --- /sq: 授权 (仅老板) ---
bot.command('sq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 请输入数字ID (例如 /sq 123456)');
    
    global.sqTarget = input;
    await ctx.reply(`正在授权给 ID: ${input}`, Markup.inlineKeyboard([
        [Markup.button.callback('1天', 'auth_24'), Markup.button.callback('永久', 'auth_perm')]
    ]));
});

bot.action(/auth_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const duration = ctx.match[1];
    const targetId = global.sqTarget;
    let expires = null;
    let perm = duration === 'perm';
    
    if (!perm) {
        const d = new Date();
        d.setHours(d.getHours() + 24);
        expires = d;
    }

    await pool.query(
        `INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`,
        [targetId, ADMIN_ID, expires, perm]
    );
    await ctx.editMessageText(`✅ 已授权 ID ${targetId}`);
});

// --- /cksq & /sc (仅老板) ---
bot.command('cksq', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const res = await pool.query('SELECT * FROM auth_sessions');
    let t = '📋 授权名单:\n';
    res.rows.forEach(u => t += `- ${u.user_id} (${u.is_permanent?'永久':'限时'})\n`);
    await ctx.reply(t || '无授权用户。', ADMIN_KEYBOARD);
});

bot.command('sc', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (ctx.chat.type === 'private') return ctx.reply('请在要清空的群组内发送: /sc 确认删除');
    await ctx.reply('⚠️ 请输入: `/sc 确认删除`', {parse_mode:'Markdown'});
});

bot.hears('/sc 确认删除', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID || ctx.chat.type === 'private') return;
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [ctx.chat.id]);
    await ctx.reply('🗑️ 数据已清空。');
});

// ==========================================
// 6. 启动
// ==========================================
initDB().then(() => {
    bot.launch();
    console.log('🚀 机器人全场景版启动成功！');
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT);
process.once('SIGINT', () => bot.stop('SIGINT'));
