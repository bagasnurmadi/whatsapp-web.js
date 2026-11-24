'use strict';

/**
 * Diagnostic only: launches Chromium, loads WhatsApp Web login, and reports
 * structural runtime signals (no QR payloads, tokens, cookies values, phone
 * numbers, or credentials are printed).
 *
 * Usage:
 *   node tools/diagnostics/inspect-runtime.js --seconds 60 --ua native --headless
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

function parseArgs(argv) {
    const out = {
        seconds: 45,
        ua: 'native',
        headless: true,
        timeout: 60000,
        chrome: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--seconds') out.seconds = Number(argv[++i]);
        else if (arg === '--ua') out.ua = argv[++i];
        else if (arg === '--timeout') out.timeout = Number(argv[++i]);
        else if (arg === '--chrome') out.chrome = argv[++i];
        else if (arg === '--headed') out.headless = false;
        else if (arg === '--headless') out.headless = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));

function pageSnapshot() {
    const safe = (fn) => {
        try {
            return fn();
        } catch (err) {
            return { error: String(err && err.message ? err.message : err) };
        }
    };
    const moduleProbe = (name) => {
        return safe(() => {
            const req = window.require;
            if (typeof req !== 'function') return { status: 'no-require' };
            const mod = req(name);
            if (!mod) return { status: 'falsy', type: typeof mod };
            const keys = Object.keys(mod);
            return {
                status: 'ok',
                type: typeof mod,
                keys: keys.slice(0, 30),
                keyCount: keys.length,
            };
        });
    };
    const testids = safe(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
            .map((el) => el.getAttribute('data-testid'))
            .filter((v, i, a) => v && a.indexOf(v) === i)
            .slice(0, 40),
    );
    const bodyClasses = safe(() =>
        Array.from(document.body?.classList || []).slice(0, 20),
    );
    const localKeys = safe(() => Object.keys(window.localStorage).sort());
    const idbNames = safe(() => {
        if (!window.indexedDB || !window.indexedDB.databases) return null;
        return { async: true };
    });

    return {
        pathname: location.pathname,
        title: document.title,
        readyState: document.readyState,
        ua: navigator.userAgent,
        version: safe(() => window.Debug?.VERSION ?? null),
        debugKeys: safe(() => Object.keys(window.Debug || {}).slice(0, 40)),
        requireType: typeof window.require,
        requireKeys: safe(() =>
            typeof window.require === 'function'
                ? Object.keys(window.require).slice(0, 20)
                : [],
        ),
        requireSource: safe(() =>
            typeof window.require === 'function'
                ? String(window.require).slice(0, 400)
                : null,
        ),
        modules: {
            WAWebSocketModel: moduleProbe('WAWebSocketModel'),
            WAWebConnModel: moduleProbe('WAWebConnModel'),
            WAWebCmd: moduleProbe('WAWebCmd'),
            WAWebSignalStoreApi: moduleProbe('WAWebSignalStoreApi'),
            WABase64: moduleProbe('WABase64'),
            WAWebAltDeviceLinkingApi: moduleProbe('WAWebAltDeviceLinkingApi'),
        },
        socketState: safe(() => {
            const s = window.require?.('WAWebSocketModel')?.Socket;
            return {
                exists: Boolean(s),
                state: s?.state ?? null,
                hasSynced: s?.hasSynced ?? null,
                stateKeys: s ? Object.keys(s).slice(0, 20) : [],
            };
        }),
        connRef: safe(() => {
            const conn = window.require?.('WAWebConnModel')?.Conn;
            const ref = conn?.ref;
            return {
                connExists: Boolean(conn),
                connKeys: conn ? Object.keys(conn).slice(0, 20) : [],
                refExists: ref !== undefined && ref !== null,
                refType: typeof ref,
                refLength: typeof ref === 'string' ? ref.length : null,
            };
        }),
        loginUi: safe(() => ({
            loginPath: location.pathname.startsWith('/login'),
            qrCodeTestId: Boolean(
                document.querySelector('[data-testid="link-device-qr-code"]'),
            ),
            qrCanvasTestId: Boolean(
                document.querySelector(
                    '[data-testid="link-device-qr-code"] canvas, canvas',
                ),
            ),
            phonePairingLink: Boolean(
                document.querySelector(
                    '[data-testid="link_device_qr_phone_number_link"], [data-testid="link_device_qr_phone_number_shortcut_link"]',
                ),
            ),
            landingLink: Boolean(
                document.querySelector(
                    '[data-testid="link_device_landing_get_started_link"]',
                ),
            ),
        })),
        globals: safe(() =>
            Object.keys(window)
                .filter((k) =>
                    /WAWeb|whatsapp|webpack|WebSocket|require/i.test(k),
                )
                .slice(0, 60),
        ),
        webpackChunks: safe(() => {
            const chunks = Object.keys(window).filter((k) =>
                /^webpackChunk/.test(k),
            );
            return chunks.map((k) => ({
                name: k,
                arrays: Array.isArray(window[k]) ? window[k].length : null,
            }));
        }),
        dom: {
            bodyChildren: safe(() => document.body?.children.length ?? 0),
            canvases: safe(() => document.querySelectorAll('canvas').length),
            images: safe(() => document.querySelectorAll('img').length),
            inputs: safe(() => document.querySelectorAll('input').length),
            qrLike: safe(
                () =>
                    document.querySelectorAll(
                        '[data-ref], canvas, [data-testid*="qr" i], [aria-label*="qr" i]',
                    ).length,
            ),
            testids: testids,
            bodyClasses: bodyClasses,
            bodyTextLength: safe(() => (document.body?.innerText || '').length),
        },
        storage: {
            localKeys: localKeys,
            cookieCount: safe(
                () => document.cookie.split(';').filter(Boolean).length,
            ),
            idbApi: idbNames,
        },
    };
}

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-inspect-'));
    const launchOpts = {
        headless: args.headless,
        defaultViewport: null,
        userDataDir: profile,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ],
    };
    if (args.chrome) launchOpts.executablePath = args.chrome;

    let browser;
    try {
        browser = await puppeteer.launch(launchOpts);
        const page = (await browser.pages())[0];
        const ua = await browser.userAgent();
        let effectiveUA = ua;
        if (args.ua === 'chrome131') {
            effectiveUA = ua
                .replace(/Chrome\/[\d.]+/, 'Chrome/131.0.0.0')
                .replace('HeadlessChrome', 'Chrome');
        } else if (args.ua === 'native-no-headless') {
            effectiveUA = ua.replace('HeadlessChrome', 'Chrome');
        }
        await page.setUserAgent(effectiveUA);

        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                const text = msg.text();
                console.log(
                    '[console.error]',
                    text.length > 200 ? text.slice(0, 200) + '…' : text,
                );
            }
        });
        page.on('pageerror', (err) => {
            console.log('[pageerror]', String(err.message).slice(0, 200));
        });

        const start = Date.now();
        await page.goto('https://web.whatsapp.com/', {
            waitUntil: 'domcontentloaded',
            timeout: args.timeout,
            referer: 'https://whatsapp.com/',
        });
        console.log(
            'navigated in',
            Date.now() - start,
            'ms; effective UA:',
            effectiveUA,
        );

        const samples = Math.max(1, Math.ceil((args.seconds * 1000) / 5000));
        for (let i = 0; i <= samples; i++) {
            const snap = await page.evaluate(pageSnapshot);
            console.log(
                `\n--- sample ${i} t=${Date.now() - start}ms ---\n` +
                    JSON.stringify(snap, null, 2),
            );
            if (i < samples) {
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
    } catch (err) {
        console.error('DIAGNOSTIC_ERROR', err && err.stack ? err.stack : err);
        process.exitCode = 1;
    } finally {
        if (browser) {
            await browser
                .close()
                .catch((e) => console.error('close error', e.message));
        }
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
        console.log('profile cleaned:', !fs.existsSync(profile));
    }
})();
