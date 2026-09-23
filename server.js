require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'hassinaziz555@gmail.com').toLowerCase();
const ADMIN_CODE = process.env.ADMIN_CODE || 'aziz2020h';
const PUBLIC_DIR = path.join(__dirname, 'src');
const DATA_FILE = path.join(__dirname, 'portfolio-data.json');
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || 'aziz_portfolio';
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || 'site_data';
const sessions = new Map();
const loginAttempts = new Map();
let mongoClient;
let mongoCollection;
let mongoState = MONGODB_URI ? 'connecting' : 'not-configured';
let mongoError = '';

function getMongoConfigurationError() {
    if (!MONGODB_URI) return '';

    try {
        const uri = new URL(MONGODB_URI);
        if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)) {
            return 'MONGODB_URI must start with mongodb:// or mongodb+srv://.';
        }
        if (!uri.hostname) return 'MONGODB_URI is missing its Atlas hostname.';
        if (uri.protocol === 'mongodb+srv:' && !uri.hostname.endsWith('.mongodb.net')) {
            return 'The Atlas hostname must end in .mongodb.net. Copy the full URI from Atlas > Connect > Drivers.';
        }
    } catch {
        return 'MONGODB_URI is not a valid connection string. Copy the full URI from Atlas > Connect > Drivers.';
    }

    return '';
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

async function getMongoCollection() {
    if (!MONGODB_URI) return null;
    if (mongoCollection) return mongoCollection;

    const configurationError = getMongoConfigurationError();
    if (configurationError) {
        mongoState = 'invalid-config';
        mongoError = configurationError;
        console.error(`MongoDB configuration error: ${configurationError}`);
        return null;
    }

    try {
        mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
        await mongoClient.connect();
        mongoCollection = mongoClient.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
        await mongoCollection.createIndex({ _id: 1 }, { unique: true });
        mongoState = 'connected';
        mongoError = '';
        return mongoCollection;
    } catch (error) {
        mongoState = 'unavailable';
        if (mongoClient) await mongoClient.close().catch(() => {});
        mongoClient = undefined;
        mongoCollection = undefined;
        const dnsError = ['ENOTFOUND', 'ECONNREFUSED', 'ESERVFAIL'].includes(error.code)
            || /querySrv|resolveSrv/i.test(error.message);
        mongoError = dnsError
            ? 'Atlas hostname was not found. Copy the exact connection string from Atlas > Connect > Drivers; do not type the cluster hostname manually.'
            : 'MongoDB Atlas could not be reached. Check the connection string, database user, and Atlas Network Access list.';
        console.error(`MongoDB connection failed: ${mongoError}`);
        return null;
    }
}

async function getPortfolioData() {
    const collection = await getMongoCollection();
    if (collection) {
        const document = await collection.findOne({ _id: 'portfolio' });
        if (document?.data) return document.data;
    }

    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function savePortfolioData(data) {
    const collection = await getMongoCollection();
    if (MONGODB_URI && !collection) throw new Error('MongoDB Atlas is unavailable. Check MONGODB_URI and the Atlas network access list.');

    if (collection) {
        await collection.updateOne(
            { _id: 'portfolio' },
            { $set: { data, updatedAt: new Date() } },
            { upsert: true }
        );
    }

    // Keeps a local recovery copy without becoming the shared source of truth.
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
                if (body.length > 14_000_000) req.destroy();
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (error) { reject(error); }
        });
    });
}

function getCookie(req, name) {
    const raw = req.headers.cookie || '';
    return raw.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.split('=').slice(1).join('=');
}

function getAdmin(req) {
    const token = getCookie(req, 'portfolio_admin');
    if (!token) return null;
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) {
        if (token) sessions.delete(token);
        return null;
    }
    return session.email;
}

function getClientAddress(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function canAttemptLogin(req) {
    const address = getClientAddress(req);
    const record = loginAttempts.get(address);
    if (!record) return true;
    if (record.blockedUntil && record.blockedUntil > Date.now()) return false;
    if (record.blockedUntil) loginAttempts.delete(address);
    return true;
}

function registerLoginFailure(req) {
    const address = getClientAddress(req);
    const record = loginAttempts.get(address) || { count: 0, blockedUntil: 0 };
    record.count += 1;
    if (record.count >= 5) {
        record.count = 0;
        record.blockedUntil = Date.now() + 10 * 60 * 1000;
    }
    loginAttempts.set(address, record);
}

function contentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';
}

async function handleApi(req, res) {
    if (req.method === 'GET' && req.url === '/api/admin/status') {
        const email = getAdmin(req);
        return send(res, 200, { admin: Boolean(email), email, database: mongoState });
    }

    if (req.method === 'GET' && req.url === '/api/database/status') {
        await getMongoCollection();
        return send(res, 200, {
            database: mongoState,
            provider: mongoState === 'connected' ? 'mongodb-atlas' : 'local-backup',
            error: mongoError || null
        });
    }

    if (req.method === 'POST' && req.url === '/api/admin/login') {
        if (!canAttemptLogin(req)) {
            return send(res, 429, { ok: false, message: 'Too many attempts. Try again in 10 minutes.' });
        }
        const body = await readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const code = String(body.code || '').trim();
        if (email !== ADMIN_EMAIL || code !== ADMIN_CODE) {
            registerLoginFailure(req);
            return send(res, 401, { ok: false, message: 'Wrong admin access.' });
        }
        loginAttempts.delete(getClientAddress(req));
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { email, expires: Date.now() + 1000 * 60 * 60 * 24 * 30 });
        return send(res, 200, { ok: true, email }, {
            'Set-Cookie': `portfolio_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
        });
    }

    if (req.method === 'POST' && req.url === '/api/admin/logout') {
        const token = getCookie(req, 'portfolio_admin');
        if (token) sessions.delete(token);
        return send(res, 200, { ok: true }, {
            'Set-Cookie': 'portfolio_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
        });
    }

    if (req.method === 'GET' && req.url === '/api/data') {
        return send(res, 200, await getPortfolioData());
    }

    if (req.method === 'POST' && req.url === '/api/data') {
        if (!getAdmin(req)) return send(res, 403, { ok: false, message: 'Admin only.' });
        const body = await readBody(req);
        await savePortfolioData(body);
        return send(res, 200, { ok: true, database: mongoState });
    }

    return send(res, 404, { ok: false, message: 'Not found.' });
}

function serveStatic(req, res) {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const urlPath = rawPath.startsWith('/src/') ? rawPath.slice(4) : rawPath;
    const requested = urlPath === '/' || urlPath === '/admin' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, requested);
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? filePath
        : path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': contentType(finalPath) });
    fs.createReadStream(finalPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
    try {
        if ((req.url || '').startsWith('/api/')) return await handleApi(req, res);
        serveStatic(req, res);
    } catch (error) {
        const message = error instanceof Error && error.message
            ? error.message
            : 'Server error.';
        send(res, 500, { ok: false, message });
    }
});

server.listen(PORT, () => {
    console.log(`Portfolio running at http://localhost:${PORT}`);
    console.log(`Admin email: ${ADMIN_EMAIL}`);
    console.log(MONGODB_URI ? 'MongoDB Atlas: connecting...' : 'MongoDB Atlas: add MONGODB_URI to .env to enable shared data.');
});

process.on('SIGINT', async () => {
    if (mongoClient) await mongoClient.close().catch(() => {});
    process.exit(0);
});
