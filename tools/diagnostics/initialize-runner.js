'use strict';

/**
 * Real-browser initialization runner used for before/after and upstream
 * comparison. It never prints QR payloads, pairing codes, cookies, profile
 * data, or phone numbers.
 *
 * Usage:
 *   node tools/diagnostics/initialize-runner.js --lib . --cache none --ua native
 *   NODE_PATH=<repo>/node_modules node tools/diagnostics/initialize-runner.js \
 *       --lib /path/to/upstream --cache none --ua native
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
    const out = {
        lib: path.resolve(__dirname, '../..'),
        cache: 'none',
        ua: 'native',
        authTimeout: 30000,
        hardTimeout: 90000,
        waitAfterQr: 1500,
        headless: true,
        executable: undefined,
        clientId: `diag-${Date.now()}-${process.pid}`,
        cachePath: undefined,
        pairing: undefined,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--lib') out.lib = path.resolve(argv[++i]);
        else if (a === '--cache') out.cache = argv[++i];
        else if (a === '--cache-path') out.cachePath = path.resolve(argv[++i]);
        else if (a === '--ua') out.ua = argv[++i];
        else if (a === '--auth-timeout') out.authTimeout = Number(argv[++i]);
        else if (a === '--hard-timeout') out.hardTimeout = Number(argv[++i]);
        else if (a === '--wait-after-qr') out.waitAfterQr = Number(argv[++i]);
        else if (a === '--client-id') out.clientId = argv[++i];
        else if (a === '--pairing') out.pairing = argv[++i];
        else if (a === '--headed') out.headless = false;
        else if (a === '--headless') out.headless = true;
        else if (a === '--executable') out.executable = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));

function logStage(stage, detail) {
    console.error(
        `[stage] t=${Date.now() - START}ms ${stage}` +
            (detail ? ` ${JSON.stringify(detail)}` : ''),
    );
}

function runtimeSnapshot() {
    const safe = (fn) => {
        try {
            return fn();
        } catch {
            return null;
        }
    };
    const mod = (name) => {
        try {
            const m = window.require ? window.require(name) : undefined;
            return m === undefined
                ? 'undefined'
                : m === null
                  ? 'null'
                  : `object(${Object.keys(m).length})`;
        } catch {
            return 'throw';
        }
    };
    const socket = safe(
        () => window.require?.('WAWebSocketModel')?.Socket || null,
    );
    const conn = safe(() => window.require?.('WAWebConnModel')?.Conn || null);
    return {
        pathname: location.pathname,
        version: safe(() => window.Debug?.VERSION ?? null),
        hasRequire: typeof window.require === 'function',
        socketExists: Boolean(socket),
        socketState: socket?.state ?? null,
        socketHasSynced: socket?.hasSynced ?? null,
        socketModule: mod('WAWebSocketModel'),
        connExists: Boolean(conn),
        connRefExists: conn?.ref !== undefined && conn?.ref !== null,
        qrUi: Boolean(
            document.querySelector('[data-testid="link-device-qr-code"]'),
        ),
        phoneUi: Boolean(
            document.querySelector(
                '[data-testid="link_device_qr_phone_number_link"], [data-testid="link_device_qr_phone_number_shortcut_link"]',
            ),
        ),
        wwebjs: typeof window.WWebJS !== 'undefined',
        canvasCount: document.querySelectorAll('canvas').length,
    };
}

const START = Date.now();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-init-'));
const authPath = path.join(tempRoot, 'auth');
const cachePath = args.cachePath || path.join(tempRoot, 'cache');
fs.mkdirSync(authPath, { recursive: true });

const events = [];
let qrCount = 0;
let codeCount = 0;
let firstQrAt = null;
let client = null;
let browserClosed = false;
let monitorTimer = null;
let timeline = [];
let lastTimelineKey = '';

function record(type, payload) {
    events.push({ t: Date.now() - START, type, ...payload });
}

async function snapshotClient(tag) {
    if (!client || !client.pupPage) return null;
    try {
        const snap = await client.pupPage.evaluate(runtimeSnapshot);
        const key = JSON.stringify([
            snap.pathname,
            snap.version,
            snap.socketExists,
            snap.socketState,
            snap.connRefExists,
            snap.qrUi,
            snap.wwebjs,
        ]);
        if (key !== lastTimelineKey) {
            lastTimelineKey = key;
            timeline.push({ t: Date.now() - START, tag, ...snap });
            logStage('runtime', { tag, ...snap });
        }
        return snap;
    } catch (err) {
        return { error: String(err && err.message).slice(0, 160) };
    }
}

(async () => {
    const lib = require(args.lib);
    const { Client, LocalAuth } = lib;
    if (!Client || !LocalAuth) {
        throw new Error(
            `Library at ${args.lib} does not export Client/LocalAuth`,
        );
    }

    const options = {
        authStrategy: new LocalAuth({
            clientId: args.clientId,
            dataPath: authPath,
        }),
        authTimeoutMs: args.authTimeout,
        webVersionCache: {
            type: args.cache,
            ...(args.cache === 'local' ? { path: cachePath } : {}),
        },
        puppeteer: {
            headless: args.headless,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
            ...(args.executable ? { executablePath: args.executable } : {}),
        },
    };

    if (args.ua === 'native') {
        options.userAgent = false;
    } else if (args.ua === 'chrome131') {
        options.userAgent =
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    }

    if (args.pairing) {
        options.pairWithPhoneNumber = {
            phoneNumber: args.pairing,
            showNotification: false,
            intervalMs: 180000,
        };
    }

    client = new Client(options);
    client.on('qr', (qr) => {
        qrCount++;
        if (firstQrAt === null) firstQrAt = Date.now() - START;
        record('qr', {
            count: qrCount,
            length: typeof qr === 'string' ? qr.length : null,
        });
    });
    client.on('code', (code) => {
        codeCount++;
        record('code', {
            count: codeCount,
            length: typeof code === 'string' ? code.length : null,
        });
    });
    client.on('authenticated', () => record('authenticated', {}));
    client.on('ready', () => record('ready', {}));
    client.on('auth_failure', (msg) =>
        record('auth_failure', { message: String(msg).slice(0, 120) }),
    );
    client.on('disconnected', (reason) =>
        record('disconnected', { reason: String(reason).slice(0, 80) }),
    );
    client.on('change_state', (state) => record('change_state', { state }));
    client.on('loading_screen', (percent) =>
        record('loading_screen', { percent }),
    );

    logStage('initialize:start', {
        lib: args.lib,
        cache: args.cache,
        ua: args.ua,
        authTimeout: args.authTimeout,
    });

    monitorTimer = setInterval(() => {
        snapshotClient('poll').catch(() => {});
    }, 1000);

    let initError = null;
    let hardTimeout = false;
    const initPromise = client.initialize().catch((err) => {
        initError = err;
        record('initialize_error', {
            name: err && err.name,
            message: String(err && err.message ? err.message : err).slice(
                0,
                240,
            ),
            stack: String(err && err.stack ? err.stack : '')
                .split('\n')
                .slice(0, 5),
        });
    });

    const hardTimer = new Promise((resolve) => {
        const timer = setTimeout(() => {
            hardTimeout = true;
            resolve('hard-timeout');
        }, args.hardTimeout);
        timer.unref?.();
    });
    const initSettled = initPromise.then(() => 'settled');
    await Promise.race([initSettled, hardTimer]);

    if (hardTimeout && !initError) {
        record('hard_timeout', { ms: args.hardTimeout });
        logStage('initialize:hard-timeout', { ms: args.hardTimeout });
    }

    if (qrCount > 0 && args.waitAfterQr > 0) {
        await new Promise((r) => setTimeout(r, args.waitAfterQr));
    }

    const finalSnapshot = await snapshotClient('final');

    if (monitorTimer) clearInterval(monitorTimer);

    let destroyError = null;
    try {
        await Promise.race([
            client.destroy(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('destroy timeout')), 15000),
            ),
        ]);
    } catch (err) {
        destroyError = String(err && err.message ? err.message : err).slice(
            0,
            160,
        );
    }
    browserClosed = client.pupBrowser?.isConnected?.() === false;

    const result = {
        library: args.lib,
        cache: args.cache,
        ua: args.ua,
        clientId: args.clientId,
        durationMs: Date.now() - START,
        reachedLoginPage: timeline.some((s) =>
            s.pathname?.startsWith('/login'),
        ),
        whatsappVersion:
            [...timeline].reverse().find((s) => s.version)?.version ?? null,
        finalPathname: finalSnapshot?.pathname ?? null,
        socketModuleSeen: timeline.some(
            (s) => s.socketModule && s.socketModule !== 'undefined',
        ),
        socketEverExisted: timeline.some((s) => s.socketExists),
        loginUiSeen: timeline.some((s) => s.qrUi || s.phoneUi),
        qrEventEmitted: qrCount > 0,
        qrEventCount: qrCount,
        firstQrAtMs: firstQrAt,
        codeEventEmitted: codeCount > 0,
        codeEventCount: codeCount,
        initialized: !initError && !hardTimeout,
        hardTimeout,
        error: initError
            ? {
                  name: initError.name,
                  message: String(initError.message ?? initError).slice(0, 240),
                  stack: String(initError.stack ?? '')
                      .split('\n')
                      .slice(0, 5),
              }
            : null,
        destroyError,
        browserClosed,
        authDiagnostics: client.authDiagnostics,
        authProfileCleaned: false,
        cacheProfileCleaned: false,
        events,
        timeline,
    };

    // Clean temp profiles after browser shutdown and verify.
    try {
        fs.rmSync(authPath, { recursive: true, force: true, maxRetries: 8 });
        result.authProfileCleaned = !fs.existsSync(authPath);
    } catch (err) {
        result.authProfileCleanupError = String(err.message).slice(0, 120);
    }
    try {
        fs.rmSync(cachePath, { recursive: true, force: true, maxRetries: 8 });
        result.cacheProfileCleaned = !fs.existsSync(cachePath);
    } catch (err) {
        result.cacheProfileCleanupError = String(err.message).slice(0, 120);
    }
    try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8 });
    } catch {
        // ignore
    }

    console.log('RESULT ' + JSON.stringify(result));
    process.exitCode = 0;
})().catch(async (err) => {
    console.log(
        'HARNESS_ERROR ' +
            JSON.stringify({
                message: String(err && err.message ? err.message : err),
                stack: String(err && err.stack ? err.stack : '')
                    .split('\n')
                    .slice(0, 8),
            }),
    );
    if (monitorTimer) clearInterval(monitorTimer);
    try {
        if (client) await client.destroy();
    } catch {
        // diagnostics-only cleanup
    }
    try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8 });
    } catch {
        // diagnostics-only cleanup
    }
    process.exitCode = 1;
});
