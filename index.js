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
    // Fallback to project ID if the specific bucket variable is missing
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_ID = process.env.OWNER_ID;

// --- SESSION & AUTH MIDDLEWARE ---
bot.use(session());
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (userId === OWNER_ID) return next();

    const now = Date.now();
    if (ctx.session?.authTime && (now - ctx.session.authTime < 10 * 60 * 1000)) return next();

    if (ctx.message && ctx.message.text === '1100') {
        ctx.session = { authTime: now };
        await ctx.reply('⚡ 𝗔𝗖𝗖𝗘𝗦𝗦 𝗚𝗥𝗔𝗡𝗧𝗘𝗗. Session active for 10m.');
        return mainMenu(ctx);
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

    const logEntry = {
        id: logId,
        type,
        details,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('logs').add(logEntry);
    bot.telegram.sendMessage(OWNER_ID, `🧾 [𝗟𝗢𝗚 #${String(logId).padStart(3, '0')}]\n⚡ ${type}\n📄 ${details}`);
};

const mainMenu = (ctx) => {
    return ctx.reply('💠 𝗣𝗥𝟭𝗠Ξ 𝗔𝗗𝗠𝗜𝗡 𝗡𝗘𝗧𝗪𝗢𝗥𝗞', Markup.inlineKeyboard([
        [Markup.button.callback('👥 Users', 'm_users'), Markup.button.callback('💰 Deposits', 'm_deps')],
        [Markup.button.callback('🛒 Products', 'm_prods'), Markup.button.callback('💳 Wallet', 'm_wallet')],
        [Markup.button.callback('📩 Support', 'm_supp'), Markup.button.callback('📊 Analytics', 'm_stats')],
        [Markup.button.callback('🧾 Logs', 'm_logs'), Markup.button.callback('⚙️ Settings', 'm_set')]
    ]));
};

// --- USER & WALLET MGMT ---
bot.command('wallet', async (ctx) => {
    const [_, email, amount] = ctx.message.text.split(' ');
    if (!email || isNaN(amount)) return ctx.reply('⚠️ /wallet <email> <amount>');
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return ctx.reply('❌ User not found.');
    
    await snap.docs[0].ref.update({ balance: parseFloat(amount) });
    await logAction('WALLET_EDIT', `Email: ${email} | New: ₦${amount}`);
    ctx.reply(`✅ Wallet updated for ${email}`);
});

bot.command('ban', async (ctx) => {
    const email = ctx.message.text.split(' ')[1];
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return ctx.reply('❌ User not found.');
    await snap.docs[0].ref.update({ status: 'banned' });
    await logAction('USER_BAN', email);
    ctx.reply(`🚫 ${email} restricted.`);
});

bot.command('unban', async (ctx) => {
    const email = ctx.message.text.split(' ')[1];
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return ctx.reply('❌ User not found.');
    await snap.docs[0].ref.update({ status: 'active' });
    await logAction('USER_UNBAN', email);
    ctx.reply(`✅ ${email} restored.`);
});

// --- DEPOSIT SYSTEM ---
bot.action('m_deps', async (ctx) => {
    const snap = await db.collection('deposits').where('status', '==', 'pending').get();
    if (snap.empty) return ctx.reply('No pending deposits.');
    snap.forEach(doc => {
        const d = doc.data();
        ctx.reply(`🧾 𝗡𝗘𝗪 𝗗𝗘𝗣𝗢𝗦𝗜𝗧\n👤 Email: ${d.email}\n💰 Amount: ₦${d.amount}`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ APPROVE', `app_${doc.id}`), Markup.button.callback('❌ DECLINE', `dec_${doc.id}`)]
        ]));
    });
});

bot.action(/app_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const ref = db.collection('deposits').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return ctx.deleteMessage();
    
    const d = snap.data();
    const uSnap = await db.collection('users').where('email', '==', d.email).limit(1).get();
    if (!uSnap.empty) {
        await uSnap.docs[0].ref.update({ balance: admin.firestore.FieldValue.increment(d.amount) });
        if (d.imagePath) await bucket.file(d.imagePath).delete().catch(() => {});
        await ref.delete();
        await logAction('DEPOSIT_APPROVE', `${d.email} | ₦${d.amount}`);
        ctx.deleteMessage();
        ctx.reply(`✅ Deposit Approved for ${d.email}`);
    }
});

// --- PRODUCT SYSTEM ---
bot.action('m_prods', (ctx) => {
    ctx.session.flow = 'add_prod';
    ctx.reply('Select Category:', Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Logs', 'cat_Logs'), Markup.button.callback('🔐 VPNs', 'cat_VPNs')],
        [Markup.button.callback('📱 Numbers', 'cat_Numbers'), Markup.button.callback('🤖 Bots', 'cat_Bots')]
    ]));
});

bot.action(/cat_(.+)/, (ctx) => {
    ctx.session.category = ctx.match[1];
    ctx.session.step = 1;
    ctx.reply('Enter Product Name:');
});

bot.on('text', async (ctx, next) => {
    if (ctx.session?.flow !== 'add_prod') return next();
    
    if (ctx.session.step === 1) {
        ctx.session.name = ctx.message.text;
        ctx.session.step = 2;
        ctx.reply('Enter Price:');
    } else if (ctx.session.step === 2) {
        ctx.session.price = parseFloat(ctx.message.text);
        ctx.session.step = 3;
        ctx.reply('Enter Image URL:');
    } else if (ctx.session.step === 3) {
        ctx.session.img = ctx.message.text;
        ctx.session.step = 4;
        ctx.reply('Mode? (SINGLE/MULTIPLE)');
    } else if (ctx.session.step === 4) {
        ctx.session.mode = ctx.message.text.toUpperCase();
        ctx.session.step = 5;
        ctx.reply('Send Stock (if multiple, separate by commas):');
    } else if (ctx.session.step === 5) {
        const raw = ctx.message.text;
        const stock = ctx.session.mode === 'MULTIPLE' ? raw.split(',').map(s => s.trim()) : [raw];
        
        await db.collection('products').add({
            name: ctx.session.name,
            price: ctx.session.price,
            image: ctx.session.img,
            category: ctx.session.category,
            mode: ctx.session.mode,
            stock: stock,
            stockCount: stock.length
        });
        
        await logAction('PRODUCT_ADD', ctx.session.name);
        ctx.reply('✅ Product Created.');
        ctx.session.flow = null;
    }
});

// --- SUPPORT ---
bot.action('m_supp', async (ctx) => {
    const snap = await db.collection('support').where('status', '==', 'open').get();
    if (snap.empty) return ctx.reply('No open tickets.');
    snap.forEach(doc => {
        const s = doc.data();
        ctx.reply(`🆘 𝗧𝗜𝗖𝗞𝗘𝗧: ${s.email}\n💬 ${s.message}`, Markup.inlineKeyboard([
            [Markup.button.callback('REPLY', `rep_${doc.id}`), Markup.button.callback('DISMISS', `dis_${doc.id}`)]
        ]));
    });
});

// --- ANALYTICS ---
cron.schedule('0 0 * * *', async () => {
    const users = await db.collection('users').get();
    const deps = await db.collection('deposits').get();
    bot.telegram.sendMessage(OWNER_ID, `📊 𝗗𝗔𝗜𝗟𝗬 𝗥𝗘𝗣𝗢𝗥𝗧\n👥 Users: ${users.size}\n💰 Pending Deps: ${deps.size}`);
});

bot.launch().then(() => console.log('Bot is running...'));
