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
const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_ID = process.env.OWNER_ID;

// --- SESSION ---
bot.use(session());

// --- KEYBOARD REPLIES MENU ---
const adminMenu = Markup.keyboard([
    ['👥 Users', '💰 Deposits'],
    ['🛒 Products', '📊 Analytics'],
    ['📩 Support', '🧾 Logs']
]).resize();

// --- START COMMAND & COMMAND LIST REGISTRATION ---
bot.start(async (ctx) => {
    // This sets the menu that appears when the user clicks the "/" button
    await ctx.telegram.setMyCommands([
        { command: 'start', description: 'Open Admin Dashboard' },
        { command: 'wallet', description: 'Update Balance: /wallet <email> <amt>' },
        { command: 'ban', description: 'Ban User: /ban <email>' },
        { command: 'unban', description: 'Unban User: /unban <email>' },
        { command: 'stats', description: 'View Analytics' }
    ]);

    const welcomeMsg = `💠 𝗣𝗥𝟭𝗠Ξ 𝗔𝗗𝗠𝗜𝗡 𝗡𝗘𝗧𝗪𝗢𝗥𝗞\n\nUse the keyboard buttons below to manage the system.`;
    return ctx.reply(welcomeMsg, adminMenu);
});

// --- AUTH MIDDLEWARE (Moved below Start to ensure commands register) ---
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (userId === OWNER_ID) return next();

    const now = Date.now();
    if (ctx.session?.authTime && (now - ctx.session.authTime < 10 * 60 * 1000)) return next();

    if (ctx.message && ctx.message.text === '1100') {
        ctx.session = { authTime: now };
        await ctx.reply('⚡ 𝗔𝗖𝗖𝗘𝗦𝗦 𝗚𝗥𝗔𝗡𝗧𝗘𝗗.', adminMenu);
        return;
    }
    // Only prompt for password if not authorized
    if (ctx.callbackQuery) return ctx.answerCbQuery('Session Expired. Enter Password.');
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
        id: logId, type, details,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    bot.telegram.sendMessage(OWNER_ID, `🧾 [𝗟𝗢𝗚 #${logId}]\n⚡ ${type}\n📄 ${details}`);
};

// --- HANDLERS FOR KEYBOARD REPLIES ---
bot.hears('💰 Deposits', async (ctx) => {
    const snap = await db.collection('deposits').where('status', '==', 'pending').get();
    if (snap.empty) return ctx.reply('No pending deposits.');
    
    for (const doc of snap.docs) {
        const d = doc.data();
        const text = `🧾 𝗣𝗘𝗡𝗗𝗜𝗡𝗚 𝗗𝗘𝗣𝗢𝗦𝗜𝗧\n👤 User: ${d.email}\n💰 Amount: ₦${d.amount.toLocaleString()}`;
        await ctx.reply(text, Markup.inlineKeyboard([
            [Markup.button.callback('✅ APPROVE', `app_${doc.id}`), Markup.button.callback('❌ DECLINE', `dec_${doc.id}`)]
        ]));
    }
});

bot.hears('🛒 Products', (ctx) => {
    ctx.session.flow = 'add_prod';
    ctx.reply('Select Store Category:', Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Social Logs', 'cat_Logs'), Markup.button.callback('🔐 VPNs', 'cat_VPNs')],
        [Markup.button.callback('📱 SMS Numbers', 'cat_Numbers'), Markup.button.callback('🤖 Utility Bots', 'cat_Bots')]
    ]));
});

bot.hears('📊 Analytics', async (ctx) => {
    const users = await db.collection('users').get();
    const deposits = await db.collection('deposits').where('status', '==', 'approved').get();
    ctx.reply(`📊 PR1MΞ STATS\n\n👥 Total Users: ${users.size}\n💰 Approved Deposits: ${deposits.size}`);
});

// --- INLINE ACTION HANDLERS (Fix for buttons not working) ---
bot.action(/app_(.+)/, async (ctx) => {
    try {
        const id = ctx.match[1];
        const ref = db.collection('deposits').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return ctx.answerCbQuery('Not found.');

        const d = snap.data();
        const uSnap = await db.collection('users').where('email', '==', d.email).limit(1).get();

        if (!uSnap.empty) {
            await uSnap.docs[0].ref.update({ balance: admin.firestore.FieldValue.increment(d.amount) });
            await ref.update({ status: 'approved' });
            await logAction('DEPOSIT_APPROVE', `${d.email} | +₦${d.amount}`);
            await ctx.editMessageText(`✅ Approved: ₦${d.amount} for ${d.email}`);
        }
        await ctx.answerCbQuery('Approved!');
    } catch (e) { console.log(e); }
});

bot.action(/dec_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await db.collection('deposits').doc(id).update({ status: 'declined' });
    await ctx.editMessageText('❌ Deposit Declined.');
    await ctx.answerCbQuery('Declined.');
});

bot.action(/cat_(.+)/, (ctx) => {
    ctx.session.category = ctx.match[1];
    ctx.session.step = 1;
    ctx.editMessageText(`Adding to ${ctx.session.category}.\nEnter Product Name:`);
});

// --- COMMANDS ---
bot.command('wallet', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('⚠️ Usage: /wallet user@example.com 5000');
    const snap = await db.collection('users').where('email', '==', args[1]).limit(1).get();
    if (snap.empty) return ctx.reply('❌ User not found.');
    await snap.docs[0].ref.update({ balance: parseFloat(args[2]) });
    ctx.reply(`✅ Wallet updated for ${args[1]}`);
});

// --- PRODUCT FLOW ---
bot.on('text', async (ctx, next) => {
    if (ctx.session?.flow !== 'add_prod' || !ctx.session.step) return next();
    
    const text = ctx.message.text;
    if (ctx.session.step === 1) {
        ctx.session.name = text; ctx.session.step = 2; ctx.reply('Enter Price:');
    } else if (ctx.session.step === 2) {
        ctx.session.price = parseFloat(text); ctx.session.step = 3; ctx.reply('Enter Image URL:');
    } else if (ctx.session.step === 3) {
        ctx.session.img = text; ctx.session.step = 4; ctx.reply('Sale Mode? (SINGLE/MULTIPLE)');
    } else if (ctx.session.step === 4) {
        ctx.session.mode = text.toUpperCase(); ctx.session.step = 5; ctx.reply('Paste Stock Data:');
    } else if (ctx.session.step === 5) {
        const stock = ctx.session.mode === 'MULTIPLE' ? text.split(',').map(s => s.trim()) : [text];
        await db.collection('products').add({
            name: ctx.session.name, price: ctx.session.price, image: ctx.session.img,
            category: ctx.session.category, mode: ctx.session.mode, stock: stock,
            stockCount: stock.length, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        ctx.reply('✅ Product deployed.', adminMenu);
        ctx.session.flow = null;
    }
});

bot.launch().then(() => console.log('PR1MΞ Admin Bot Online'));
