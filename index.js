const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const cron = require('node-cron');
require('dotenv').config();

// --- FIREBASE CONFIGURATION ---
const privateKey = process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined;

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_ID = process.env.OWNER_ID;

// --- SESSION & AUTH MIDDLEWARE ---
bot.use(session());

// --- START COMMAND (HELP MENU) ---
bot.start(async (ctx) => {
    const helpMessage = `
💠 𝗣𝗥𝟭𝗠Ξ 𝗔𝗗𝗠𝗜𝗡 𝗖𝗢𝗡𝗧𝗥𝗢𝗟
Available Commands:

👥 𝗨𝗦𝗘𝗥 𝗠𝗚𝗠𝗧
/wallet <email> <amt> - Set user balance
/ban <email> - Restrict user access
/unban <email> - Restore user access

🛠 𝗦𝗬𝗦𝗧𝗘𝗠
/start - Show this help menu
/stats - View quick analytics

Use the dashboard below for visual management:
    `;
    return ctx.reply(helpMessage, Markup.inlineKeyboard([
        [Markup.button.callback('👥 Users', 'm_users'), Markup.button.callback('💰 Deposits', 'm_deps')],
        [Markup.button.callback('🛒 Products', 'm_prods'), Markup.button.callback('📊 Analytics', 'm_stats')],
        [Markup.button.callback('📩 Support', 'm_supp'), Markup.button.callback('🧾 Logs', 'm_logs')]
    ]));
});

bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (userId === OWNER_ID) return next();

    const now = Date.now();
    if (ctx.session?.authTime && (now - ctx.session.authTime < 10 * 60 * 1000)) return next();

    if (ctx.message && ctx.message.text === '1100') {
        ctx.session = { authTime: now };
        await ctx.reply('⚡ 𝗔𝗖𝗖𝗘𝗦𝗦 𝗚𝗥𝗔𝗡𝗧𝗘𝗗.');
        return ctx.reply('Use /start to begin.');
    }
    return ctx.reply('🛑 𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗. Enter system password:');
});

// --- CORE UTILITIES ---
const logAction = async (type, details) => {
    const logRef = db.collection('system_logs').doc('counter');
    const logId = await db.runTransaction(async (t) => {
        const snap = await t.get(logRef);
        const next = snap.exists ? snap.data().count + 1 : 1;
        t.set(logRef, { count: next });
        return next;
    });

    await db.collection('logs').add({
        id: logId,
        type,
        details,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    bot.telegram.sendMessage(OWNER_ID, `🧾 [𝗟𝗢𝗚 #${logId}]\n⚡ ${type}\n📄 ${details}`);
};

// --- USER & WALLET MGMT ---
bot.command('wallet', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const email = args[1];
    const amount = args[2];
    
    if (!email || isNaN(amount)) return ctx.reply('⚠️ Usage: /wallet user@example.com 5000');
    
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return ctx.reply('❌ User not found.');
    
    await snap.docs[0].ref.update({ balance: parseFloat(amount) });
    await logAction('WALLET_MANUAL_SET', `Email: ${email} | New: ₦${amount}`);
    ctx.reply(`✅ Wallet updated for ${email}`);
});

// --- DEPOSIT SYSTEM (COMPATIBLE WITH FUND.HTML) ---
bot.action('m_deps', async (ctx) => {
    const snap = await db.collection('deposits').where('status', '==', 'pending').get();
    if (snap.empty) return ctx.reply('No pending deposits.');
    
    for (const doc of snap.docs) {
        const d = doc.data();
        const text = `🧾 𝗣𝗘𝗡𝗗𝗜𝗡𝗚 𝗗𝗘𝗣𝗢𝗦𝗜𝗧\n👤 User: ${d.email}\n💰 Amount: ₦${d.amount.toLocaleString()}\n📅 Date: ${d.timestamp?.toDate().toLocaleString() || 'N/A'}`;
        
        await ctx.reply(text, Markup.inlineKeyboard([
            [Markup.button.callback('✅ APPROVE', `app_${doc.id}`), Markup.button.callback('❌ DECLINE', `dec_${doc.id}`)]
        ]));
    }
});

bot.action(/app_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const ref = db.collection('deposits').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return ctx.answerCbQuery('Deposit record not found.');
    
    const d = snap.data();
    const uSnap = await db.collection('users').where('email', '==', d.email).limit(1).get();
    
    if (!uSnap.empty) {
        await uSnap.docs[0].ref.update({ 
            balance: admin.firestore.FieldValue.increment(d.amount) 
        });
        await ref.update({ status: 'approved' }); // Updates fund.html history
        await logAction('DEPOSIT_APPROVE', `${d.email} | +₦${d.amount}`);
        await ctx.editMessageText(`✅ Approved: ₦${d.amount} for ${d.email}`);
    } else {
        ctx.reply('❌ Error: User account missing.');
    }
});

bot.action(/dec_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await db.collection('deposits').doc(id).update({ status: 'declined' });
    await ctx.editMessageText('❌ Deposit Declined.');
});

// --- PRODUCT SYSTEM (PR1MΞ L0GS SPECIFIC) ---
bot.action('m_prods', (ctx) => {
    ctx.session.flow = 'add_prod';
    ctx.reply('Select Store Category:', Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Social Logs', 'cat_Logs'), Markup.button.callback('🔐 VPNs', 'cat_VPNs')],
        [Markup.button.callback('📱 SMS Numbers', 'cat_Numbers'), Markup.button.callback('🤖 Utility Bots', 'cat_Bots')]
    ]));
});

bot.action(/cat_(.+)/, (ctx) => {
    ctx.session.category = ctx.match[1];
    ctx.session.step = 1;
    ctx.reply(`Adding to ${ctx.session.category}.\nEnter Product Name:`);
});

bot.on('text', async (ctx, next) => {
    if (ctx.session?.flow !== 'add_prod') return next();
    
    const step = ctx.session.step;
    const text = ctx.message.text;

    if (step === 1) {
        ctx.session.name = text;
        ctx.session.step = 2;
        ctx.reply('Enter Price (Numbers only):');
    } else if (step === 2) {
        ctx.session.price = parseFloat(text);
        ctx.session.step = 3;
        ctx.reply('Enter Image URL (Cyberpunk style preferred):');
    } else if (step === 3) {
        ctx.session.img = text;
        ctx.session.step = 4;
        ctx.reply('Sale Mode? (SINGLE / MULTIPLE)');
    } else if (step === 4) {
        ctx.session.mode = text.toUpperCase();
        ctx.session.step = 5;
        ctx.reply('Paste Stock Data (If Multiple, separate items with commas):');
    } else if (step === 5) {
        const stock = ctx.session.mode === 'MULTIPLE' ? text.split(',').map(s => s.trim()) : [text];
        
        await db.collection('products').add({
            name: ctx.session.name,
            price: ctx.session.price,
            image: ctx.session.img,
            category: ctx.session.category,
            mode: ctx.session.mode,
            stock: stock,
            stockCount: stock.length,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        await logAction('PRODUCT_ADD', `${ctx.session.category}: ${ctx.session.name}`);
        ctx.reply('✅ Product deployed to storefront.');
        ctx.session.flow = null;
    }
});

// --- ANALYTICS ---
bot.command('stats', async (ctx) => {
    const users = await db.collection('users').get();
    const sales = await db.collection('logs').where('type', '==', 'PURCHASE').get();
    ctx.reply(`📊 PR1MΞ STATS\n\n👥 Total Users: ${users.size}\n🛒 Total Sales: ${sales.size}`);
});

cron.schedule('0 0 * * *', async () => {
    const today = new Date().toLocaleDateString();
    bot.telegram.sendMessage(OWNER_ID, `📊 DAILY REPORT - ${today}\nSystem fully operational.`);
});

bot.launch().then(() => console.log('PR1MΞ Admin Bot Online'));
