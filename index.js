/**
 * Telegram Logger Bot - 终极灭霸版
 * 功能：409修复 + 严格权限 + 违规审计 + 文件翻页 + 一键全删
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const http = require('http');
const https = require('https');

// 尝试加载 xlsx
let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { console.log('⚠️ 请在 package.json 添加 xlsx'); }

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

// --- 全局内存缓存 (用于文件翻页) ---
// 结构: { userId: { content: "完整文本...", fileName: "abc.txt", totalPages: 5 } }
const fileCache = new Map();

// 状态: 等待上传文件
const fileWaitList = new Set();

// 统一大键盘
const MAIN_KEYBOARD = Markup.keyboard([
    ['/ck 查看日志', '/bz 指令菜单'],
    ['/id ID查询', '/img 转图片模式'],
    ['/cksq 授权管理', '/sc 清空数据']
]).resize().persistent();

// ==========================================
// 2. 提示与文案
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
// 4. 核心工具函数
// ==========================================

// 通用警报
async function notifyAdmin(title, ctx, extraInfo = '') {
    if (ctx.from.id === ADMIN_ID) return; // 老板自己操作不报警
    const u = ctx.from;
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const msg = `🚨 <b>${title}</b>\n\n` +
                `👤 <b>用户:</b> ${u.first_name} ${u.last_name||''} (ID: <code>${u.id}</code>)\n` +
                `📛 <b>用户名:</b> @${u.username || '无'}\n` +
                `⏰ <b>时间:</b> ${time}\n` +
                `${extraInfo}`;
    try { await bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' }); } catch (e) {}
}

// 记录日志
async function logMessage(ctx, eventType, oldContent = null) {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg || ctx.chat.type === 'private') return;
    const content = msg.text || msg.caption || `[媒体消息]`;
    const chatTitle = msg.chat.title || '未知群组';
    try {
        await pool.query(
            `INSERT INTO messages (msg_id, chat_id, chat_title, user_id, username, first_name, content, event, original_content) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [msg.message_id, msg.chat.id, chatTitle, msg.from.id, msg.from.username||'', msg.from.first_name||'', content, eventType, oldContent]
        );
    } catch (e) { console.error('Log Error:', e); }
}

async function getOldContent(msgId, chatId) {
    const res = await pool.query(`SELECT content FROM messages WHERE msg_id = $1 AND chat_id = $2 AND event = 'send' ORDER BY id DESC LIMIT 1`, [msgId, chatId]);
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
// 5. 中间件
// ==========================================
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
        if (!(await checkAuth(ctx.from.id))) {
            await notifyAdmin('未授权访问拦截', ctx, `💬 内容: ${ctx.message.text || '非文本'}`);
            await ctx.reply(NO_AUTH_MSG, { parse_mode: 'HTML' });
            return;
        }
    }
    await next();
});

// ==========================================
// 6. 指令逻辑
// ==========================================

bot.start(async (ctx) => { await ctx.reply('👋 系统就绪。', MAIN_KEYBOARD); });

// --- /ck: 查日志 (通用) ---
bot.command('ck', async (ctx) => {
    if (ctx.chat.type !== 'private') return sendLogPage(ctx, 'group', ctx.chat.id, 1);
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 暂无记录。');
    const buttons = res.rows.map(g => [Markup.button.callback(`📂 ${g.chat_title}`, `view_group_${g.chat_id}`)]);
    await ctx.reply('请选择要查看的群组:', Markup.inlineKeyboard(buttons));
});

// --- /sc: 清空数据 (带特权报警) ---
bot.command('sc', async (ctx) => {
    // 1. 如果不是老板
    if (ctx.from.id !== ADMIN_ID) {
        // 🚨 触发报警
        await notifyAdmin('⚠️ 敏感操作警告', ctx, `🔥 <b>行为:</b> 试图执行 /sc (清空数据)\n该用户已授权，但权限不足。`);
        // ⛔️ 拒绝用户
        return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' });
    }
    
    // 2. 如果是老板，正常执行
    if (ctx.chat.type !== 'private') return ctx.reply('请私聊操作。');
    const res = await pool.query('SELECT DISTINCT chat_id, chat_title FROM messages WHERE chat_id < 0');
    if (res.rows.length === 0) return ctx.reply('📭 数据库已空。');
    const buttons = res.rows.map(g => [Markup.button.callback(`🗑️ 删除: ${g.chat_title}`, `pre_wipe_${g.chat_id}`)]);
    await ctx.reply('⚠️ 请选择要清空的群组:', Markup.inlineKeyboard(buttons));
});

// --- /qc: 灭霸指令 (清空所有) ---
bot.command('qc', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return; // 只有老板能用，别人连提示都不给
    
    await ctx.reply(
        `🧨 **严重警告 (NUCLEAR WARNING)** 🧨\n\n` +
        `你正在尝试执行 **全局清空指令** (/qc)。\n` +
        `这将 **永久删除** 数据库中所有群组、所有用户的 **所有发言记录**！\n\n` +
        `此操作不可恢复！是否继续？`, 
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('☠️ 确认清空所有数据', 'do_wipe_all')],
                [Markup.button.callback('🔙 算了，手滑', 'cancel')]
            ])
        }
    );
});

// --- /img: 文件转图片/翻页 ---
bot.command('img', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' });
    fileWaitList.add(ctx.from.id);
    await ctx.reply('🖼️ <b>进入文件预览模式</b>\n发送 .xlsx 或 .txt，支持自动翻页预览。', { parse_mode: 'HTML' });
});
bot.command('cancel', (ctx) => { fileWaitList.delete(ctx.from.id); ctx.reply('已退出。'); });

// --- 文件处理核心 (支持翻页) ---
bot.on('document', async (ctx, next) => {
    if (!fileWaitList.has(ctx.from.id)) return next();
    const doc = ctx.message.document;
    const fileName = doc.file_name;
    
    let fullText = '';

    try {
        const link = await bot.telegram.getFileLink(doc.file_id);
        
        // 辅助: 下载与解析
        const download = new Promise((resolve, reject) => {
            https.get(link, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
        });

        const buffer = await download;

        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            if (!XLSX) return ctx.reply('❌ 缺少 xlsx 库');
            const wb = XLSX.read(buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
            // 格式化为表格文本
            data.forEach(row => {
                const line = row.map(c => String(c).padEnd(10)).join(' | ');
                fullText += line + '\n' + '-'.repeat(Math.min(line.length, 50)) + '\n';
            });
        } else if (fileName.endsWith('.txt') || fileName.endsWith('.log')) {
            fullText = buffer.toString('utf-8');
        } else {
            return ctx.reply('⚠️ 只支持 .txt 或 .xlsx');
        }

        // --- 存入缓存并发送第一页 ---
        // 每页 3000 字符
        const pageSize = 3000;
        const totalPages = Math.ceil(fullText.length / pageSize);
        
        fileCache.set(ctx.from.id, { content: fullText, fileName, totalPages });
        
        await sendFilePage(ctx, ctx.from.id, 1);
        fileWaitList.delete(ctx.from.id);

    } catch (e) {
        console.error(e);
        ctx.reply('❌ 读取文件失败。');
    }
});

// 翻页发送函数
async function sendFilePage(ctx, userId, page) {
    const cache = fileCache.get(userId);
    if (!cache) return ctx.reply('⚠️ 文件预览会话已过期，请重新上传。');

    const pageSize = 3000;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const chunk = cache.content.substring(start, end);
    const safeChunk = chunk.replace(/</g, '&lt;').replace(/>/g, '&gt;'); // HTML 转义

    const msgText = `📄 <b>${cache.fileName}</b>\n` +
                    `页码: ${page} / ${cache.totalPages}\n\n` +
                    `<pre>${safeChunk}</pre>`;

    // 按钮逻辑
    const btns = [];
    if (page > 1) btns.push(Markup.button.callback('⬅️ 上一页', `fpage_${page - 1}`));
    btns.push(Markup.button.callback(`${page}/${cache.totalPages}`, 'noop'));
    if (page < cache.totalPages) btns.push(Markup.button.callback('下一页 ➡️', `fpage_${page + 1}`));

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(msgText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([btns]) });
        } else {
            await ctx.reply(msgText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([btns]) });
        }
    } catch (e) { console.error('翻页错误', e); }
}

// 翻页回调
bot.action(/fpage_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await sendFilePage(ctx, ctx.from.id, page);
});
bot.action('noop', (ctx) => ctx.answerCbQuery());

// --- 灭霸 /qc 执行回调 ---
bot.action('do_wipe_all', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        await pool.query('TRUNCATE TABLE messages'); // 核心：瞬间清空
        await ctx.editMessageText('☠️ <b>数据库已彻底重置。</b>\n所有记录已化为灰烬。', { parse_mode: 'HTML' });
        // 记录一下是谁干的
        console.log(`ADMIN ${ADMIN_ID} performed GLOBAL WIPE.`);
    } catch (e) {
        ctx.reply('❌ 删除失败: ' + e.message);
    }
});

// --- 普通 /sc 删除单群回调 ---
bot.action(/pre_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const id = ctx.match[1];
    await ctx.editMessageText(`⚠️ 确认删除 ID ${id}?`, Markup.inlineKeyboard([[Markup.button.callback('✅ 确认', `do_wipe_${id}`)],[Markup.button.callback('取消', 'cancel')]]));
});
bot.action(/do_wipe_(-?\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await pool.query('DELETE FROM messages WHERE chat_id=$1', [ctx.match[1]]);
    await ctx.editMessageText('✅ 已删除。');
});
bot.action('cancel', (ctx) => ctx.deleteMessage());

// --- 其他管理员指令 ---
const adminOnly = async (ctx, next) => { 
    if (ctx.from.id !== ADMIN_ID) return ctx.reply(LOW_PERM_MSG, { parse_mode: 'HTML' }); 
    await next(); 
};
bot.command('bz', adminOnly, (ctx) => ctx.reply('菜单: /ck, /id, /img, /qc, /sc, /sq'));
bot.command('cksq', adminOnly, async (ctx) => {
    const res = await pool.query('SELECT * FROM auth_sessions');
    if (res.rows.length === 0) return ctx.reply('无授权。');
    const buttons = res.rows.map(u => [Markup.button.callback(`❌ 撤销: ${u.user_id}`, `revoke_${u.user_id}`)]);
    await ctx.reply('授权管理:', Markup.inlineKeyboard(buttons));
});
bot.command('sq', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input || !/^\d+$/.test(input)) return ctx.reply('❌ 格式: /sq ID');
    global.sqTarget = input;
    const btns = [[Markup.button.callback('1小时', 'auth_1h'), Markup.button.callback('1天', 'auth_1d'), Markup.button.callback('永久', 'auth_perm')]];
    await ctx.reply(`🛡️ 授权 ID: ${input}`, Markup.inlineKeyboard(btns));
});
bot.command('id', adminOnly, async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (ctx.message.reply_to_message) return ctx.reply(`ID: ${ctx.message.reply_to_message.from.id}`);
    if (input && input.startsWith('@')) {
        const res = await pool.query('SELECT user_id, first_name FROM messages WHERE username=$1 LIMIT 1', [input.replace('@','')]);
        if(res.rows[0]) ctx.reply(`用户: ${res.rows[0].first_name}\nID: ${res.rows[0].user_id}`);
        else ctx.reply('未找到。');
    } else {
        ctx.reply(`My ID: ${ctx.from.id}\nChat ID: ${ctx.chat.id}`);
    }
});

// --- 通用回调 ---
const adminAction = async (ctx, next) => { if (ctx.from.id === ADMIN_ID) await next(); else ctx.answerCbQuery('权限不足', true); };
bot.action(/auth_(.+)/, adminAction, async (ctx) => {
    const type=ctx.match[1], target=global.sqTarget;
    let expires=new Date(), perm=false;
    if(type==='1h') expires.setHours(expires.getHours()+1); else if(type==='1d') expires.setDate(expires.getDate()+1); else perm=true;
    await pool.query(`INSERT INTO auth_sessions (user_id, authorized_by, expires_at, is_permanent) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, is_permanent=EXCLUDED.is_permanent`, [target, ADMIN_ID, perm?null:expires, perm]);
    await ctx.editMessageText(`✅ 已授权 ${target}`);
});
bot.action(/revoke_(\d+)/, adminAction, async (ctx) => { await pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [ctx.match[1]]); await ctx.editMessageText('已撤销。'); });
bot.action(/view_group_(-?\d+)/, async (ctx) => {
    const userId=ctx.from.id; const target=ctx.match[1];
    if(!(await checkAuth(userId))) return ctx.answerCbQuery('无权限');
    if(!(await isUserInChat(userId, target))) return ctx.answerCbQuery('⛔️ 无权访问此群', {show_alert:true});
    await sendLogPage(ctx, 'group', target, 1);
});

// 日志翻页导出
async function sendLogPage(ctx, type, target, page) {
    const limit=10, offset=(page-1)*limit;
    let sql=`SELECT * FROM messages WHERE `, params=[];
    if(type==='group'){sql+=`chat_id=$1`;params.push(target);}else{if(/^\d+$/.test(target)){sql+=`user_id=$1`;params.push(target);}else{sql+=`username=$1`;params.push(target);}}
    sql+=` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const res = await pool.query(sql, params);
    let title = type==='group'?'群组':`用户 ${target}`; if(type==='group'&&res.rows.length>0) title=res.rows[0].chat_title;
    let text = `📂 <b>${title}</b> (P${page})\n\n`;
    if(res.rows.length===0) text+='无记录';
    res.rows.forEach(l => {
        const t = new Date(l.created_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
        text += l.event==='edit'?`✏️ <b>${l.first_name}</b> [${t}]:\n❌ ${l.original_content}\n✅ ${l.content}\n\n`:`💬 <b>${l.first_name}</b> [${t}]:\n${l.content}\n\n`;
    });
    const btns = [[Markup.button.callback('⬅️', `page_${type}_${target}_${page-1}`), Markup.button.callback('⬇️ TXT', `export_${type}_${target}`), Markup.button.callback('➡️', `page_${type}_${target}_${page+1}`)]];
    if(ctx.callbackQuery) try{await ctx.editMessageText(text,{parse_mode:'HTML',...Markup.inlineKeyboard(btns)})}catch(e){} else await ctx.reply(text,{parse_mode:'HTML',...Markup.inlineKeyboard(btns)});
}
bot.action(/page_(group|user)_([\w@-]+)_(-?\d+)/, async (ctx) => { let p=parseInt(ctx.match[3])||1; if(p<1)p=1; await sendLogPage(ctx,ctx.match[1],ctx.match[2],p); });
bot.action(/export_(group|user)_([\w@-]+)/, async (ctx) => {
    await ctx.answerCbQuery('生成中...');
    const type=ctx.match[1], target=ctx.match[2];
    let sql=`SELECT * FROM messages WHERE `, params=[];
    if(type==='group'){sql+=`chat_id=$1`;params.push(target);}else{if(/^\d+$/.test(target)){sql+=`user_id=$1`;params.push(target);}else{sql+=`username=$1`;params.push(target);}}
    sql+=` ORDER BY created_at ASC`;
    const res = await pool.query(sql, params);
    if(res.rows.length===0) return ctx.reply('无数据');
    const u=[...new Set(res.rows.map(r=>`${r.first_name}(${r.user_id})`))].join(', ');
    let c=`REPORT: ${target}\nUsers: ${u}\nTotal: ${res.rows.length}\n\n`;
    res.rows.forEach(l => c+=`[${new Date(l.created_at).toLocaleString()}] ${l.first_name}: ${l.content}\n`);
    await ctx.replyWithDocument({source:Buffer.from(c), filename:`Report_${target}.txt`});
});

// 启动
initDB().then(async()=>{ try{await bot.telegram.deleteWebhook({drop_pending_updates:true}); await bot.launch({dropPendingUpdates:true,polling:{timeout:30,limit:100}}); console.log('🚀 终极版已启动');}catch(e){console.error(e);} });
const PORT = process.env.PORT||10000; http.createServer((q,r)=>{r.writeHead(200);r.end('OK')}).listen(PORT);
const stop=(s)=>{bot.stop(s);pool.end();process.exit(0);}; process.once('SIGINT',()=>stop('SIGINT')); process.once('SIGTERM',()=>stop('SIGTERM'));
