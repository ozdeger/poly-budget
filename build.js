import fs from 'fs';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const IMPORT = /^import[^;]*;[ \t]*$/gm;
const strip = src => src.replace(IMPORT, m => (/from '\.\//.test(m) || /from 'three';/.test(m) ? '' : m)).replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, '');
const core = strip(read('./src/core.js'));
// The remesher keeps its helpers to itself; only its exports join the shared scope.
const quad = `const { remeshQuads, QUAD_NONE, formDensity } = (() => {\n${strip(read('./src/quad.js'))}\nreturn { remeshQuads, QUAD_NONE, formDensity };\n})();`;
// So does the visibility pass for hidden areas.
const visibility = `const { computeVisibility } = (() => {\n${strip(read('./src/visibility.js'))}\nreturn { computeVisibility };\n})();`;
const collect = strip(read('./src/collect.js'));
const app = read('./src/app.js');
const appImports = (app.match(IMPORT) || []).filter(l => !/from '\.\//.test(l)).join('\n');
const appBody = app.replace(IMPORT, '');
const main = `${appImports}\n${quad}\n${visibility}\n${core}\n${collect}\nconst FBX_TEMPLATE = ${read('./src/fbx_template.json')};\n${appBody}`;
const worker = read('./src/worker.js');
const workerImports = (worker.match(IMPORT) || []).filter(l => !/from '\.\//.test(l)).join('\n');
const workerSrc = `${workerImports}\n${quad}\n${visibility}\n${core}\n${worker.replace(IMPORT, '')}`;
if (/<\/script/i.test(main + workerSrc)) throw new Error('script terminator inside inlined code');
const html = read('./src/index.html').replace('/*WORKER*/', () => workerSrc).replace('/*MAIN*/', () => main);

// index.html: the page as a full document for GitHub Pages, with the template's title, fonts and styles in the head.
const cut = html.indexOf('</style>') + '</style>'.length;
const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 1.5 15 14.5H1z' fill='%23f0b23c'/%3E%3C/svg%3E";
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Reduce a 3D model to a triangle budget in the browser, or remesh it into quads, with painted detail areas, mirror symmetry and texture re-baking.">
<link rel="icon" href="${icon}">
${html.slice(0, cut)}
<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${html.slice(cut)}
</body>
</html>
`;
fs.writeFileSync(new URL('./index.html', import.meta.url), page);

// dist/poly-budget.html: the same page without a document wrapper, for hosts that add their own.
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/poly-budget.html', import.meta.url), html);
console.log('built index.html', (page.length / 1024).toFixed(0), 'KB');
