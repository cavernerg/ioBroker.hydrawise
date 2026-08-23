/**
 * Checks that admin/i18n/<lang>.json and admin/jsonConfig.json stay in sync.
 *
 * Every label, help and text of the JSON config needs an entry in each language file,
 * and no language file may carry keys the config no longer uses.
 */
const fs = require('node:fs');
const path = require('node:path');

const LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];
const I18N_DIR = path.join('admin', 'i18n');

/**
 * Collects every translatable string of the JSON config
 *
 * @param node the node of the JSON config to walk
 * @param texts collects the strings found so far
 */
function extractTexts(node, texts = new Set()) {
    if (Array.isArray(node)) {
        node.forEach(entry => extractTexts(entry, texts));
    } else if (node && typeof node === 'object') {
        for (const key of ['label', 'help', 'text']) {
            if (typeof node[key] === 'string') {
                texts.add(node[key]);
            }
        }
        Object.values(node).forEach(value => extractTexts(value, texts));
    }
    return texts;
}

const jsonConfig = JSON.parse(fs.readFileSync(path.join('admin', 'jsonConfig.json'), 'utf8'));
const required = extractTexts(jsonConfig);
let hasErrors = false;

for (const lang of LANGUAGES) {
    const file = path.join(I18N_DIR, `${lang}.json`);
    const translations = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(translations);

    const missing = [...required].filter(text => !keys.includes(text));
    const orphaned = keys.filter(key => !required.has(key));
    const unsorted = keys.filter((key, i) => i > 0 && key < keys[i - 1]);
    const untranslated = keys.filter(key => translations[key] === '');

    if (missing.length || orphaned.length || unsorted.length || untranslated.length) {
        hasErrors = true;
        console.error(`\n=== ${lang} ===`);
        if (missing.length) {
            console.error('  missing keys:', missing);
        }
        if (orphaned.length) {
            console.error('  orphaned keys (remove these):', orphaned);
        }
        if (unsorted.length) {
            console.error('  keys not sorted alphabetically, starting at:', unsorted[0]);
        }
        if (untranslated.length) {
            console.error('  empty translations:', untranslated);
        }
    }
}

if (hasErrors) {
    process.exit(1);
}

console.log(`All ${required.size} keys match in ${LANGUAGES.length} languages.`);
