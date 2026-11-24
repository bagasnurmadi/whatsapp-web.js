/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    const exist = await page.evaluate((name) => {
        return !!window[name];
    }, name);
    if (exist) {
        return;
    }
    await page.exposeFunction(name, fn);
}

/**
 * Expose a page function, replacing an earlier binding if one exists.
 * Used by injection callbacks so re-injection after an SPA navigation does
 * not keep stale Closures bound to a superseded inject() run.
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function upsertFunction(page, name, fn) {
    const exist = await page.evaluate((name) => {
        return typeof window[name] === 'function';
    }, name);
    if (exist && typeof page.removeExposedFunction === 'function') {
        try {
            await page.removeExposedFunction(name);
        } catch {
            // Context was replaced mid-update; the old binding is gone.
            return;
        }
    } else if (exist) {
        return;
    }
    await page.exposeFunction(name, fn);
}

module.exports = { exposeFunctionIfAbsent, upsertFunction };
