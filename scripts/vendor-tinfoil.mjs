/**
 * Bundle the Tinfoil browser SDK into a self-contained ESM file for nanomem.
 *
 * Usage: npm run vendor:tinfoil
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const vendorDir = path.join(repoRoot, 'src', 'vendor');

const entryPoint = path.join(
    repoRoot,
    'node_modules/tinfoil/dist/index.browser.js'
);

const zlibShimPlugin = {
    name: 'zlib-browser-shim',
    setup(build) {
        build.onResolve({ filter: /^zlib$/ }, () => ({
            path: 'zlib',
            namespace: 'zlib-shim'
        }));
        build.onLoad({ filter: /.*/, namespace: 'zlib-shim' }, () => ({
            contents: `
                export function gunzipSync() {
                    throw new Error('zlib is not available in the browser — use DecompressionStream');
                }
            `,
            loader: 'js'
        }));
    }
};

await fs.mkdir(vendorDir, { recursive: true });

await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    outfile: path.join(vendorDir, 'tinfoil.browser.js'),
    minify: false,
    define: {
        'process.env.NODE_ENV': '"production"',
        'global': 'globalThis'
    },
    logLevel: 'info',
    plugins: [zlibShimPlugin]
});

await fs.writeFile(
    path.join(vendorDir, 'tinfoil.browser.d.ts'),
    'export declare class TinfoilAI { [key: string]: any; }\nexport default TinfoilAI;\n'
);

console.log('Tinfoil SDK vendored → nanomem/src/vendor/tinfoil.browser.js');
