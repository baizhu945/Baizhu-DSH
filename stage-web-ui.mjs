// Stage the built dsh-web-ui monorepo into a deployable layout:
//   $out/packages/<npm-name>  — family plugin packages (real files, no node_modules)
//   $out/deps/<name>          — flattened runtime dependency closure (real files)
//
// Resolution contract at runtime: home-manager copies $out/packages into
// ~/.dsh/profiles/web/node_modules/@linxin666/<name> and $out/deps into
// ~/.dsh/profiles/web/node_modules/<name>. Node then resolves each plugin's
// bare imports (schemastery/zod/ssh2/ws/cloudflared) from the flat profile
// node_modules, while @deepseek-ai/* peers resolve from the harness heal layer
// at ~/.dsh/profiles/node_modules.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(process.argv[2] ?? '.')
const OUT = resolve(process.argv[3])

// v0.2.0 的聚合包自身 + 12 个保留家族包。梁神模式由上游聚合包依赖，
// 但本地声明式 staging 刻意不部署该包；live-stats 已在上游移除。
// 目录名与 npm 包名保持一致，部署时直接落到 @linxin666 scope 下。
const FAMILY = [
  ['packages/dsh-web-ui-all', '@linxin666/dsh-web-ui-all'],
  ['packages/dsh-web-ui-settings', '@linxin666/dsh-client-ui-web-ui-settings'],
  ['packages/dsh-community-plugins', '@linxin666/dsh-client-ui-community-plugins'],
  ['packages/dsh-aionui-panel', '@linxin666/dsh-client-ui-aionui-panel'],
  ['packages/dsh-task-board', '@linxin666/dsh-client-ui-task-board'],
  ['packages/dsh-git-graph', '@linxin666/dsh-client-ui-git-graph'],
  ['packages/dsh-pet', '@linxin666/dsh-pet'],
  ['packages/dsh-remote-web-ui', '@linxin666/dsh-remote-web-ui'],
  ['packages/dsh-ssh', '@linxin666/dsh-ssh'],
  ['packages/dsh-tool-describe-image', '@linxin666/dsh-tool-describe-image'],
  ['packages/dsh-skill-explorer', '@linxin666/dsh-client-ui-skill-explorer'],
  ['packages/dsh-skins', '@linxin666/dsh-skins'],
  ['packages/skins/skin-center', '@linxin666/dsh-client-ui-skin-center'],
]

// 宿主侧(index.js)真正在运行时外部 import 的第三方包。react/qrcode.react/
// clsx 已被 tsdown 打进 lib/client.js 浏览器闭包,无需部署;@deepseek-ai/*
// 由 dsh 的 profiles/node_modules heal 层提供。
const DEPS_START = [
  'schemastery',
  'cloudflared',
  'ssh2',
  'zod',
  'ws',
  // dsh-web-ui-all's right panel is an external npm plugin rather than a
  // workspace package.  It is referenced by the aggregate cordis patch, so
  // it must be staged into the profile even though it is not under packages/.
  'dsh-better-sidebar',
]

function isInsideNodeModules(srcPath, srcRoot) {
  const rel = relative(srcRoot, srcPath)
  if (rel === '') return false
  return rel.split('/').includes('node_modules')
}

for (const [srcRel, pkgName] of FAMILY) {
  const src = join(ROOT, srcRel)
  const dst = join(OUT, 'packages', pkgName)
  if (!existsSync(src)) throw new Error(`missing family package: ${src}`)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, {
    recursive: true,
    filter: (candidate) => !isInsideNodeModules(candidate, src),
  })
  const packageJsonPath = join(dst, 'package.json')
  const pj = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (pj.name !== pkgName) throw new Error(`package name mismatch for ${srcRel}: ${pj.name}`)

  // v0.2.0's aggregate package still depends on dsh-liangshen and its
  // generated patch still inserts web-ui-liangshen. This local deployment
  // deliberately omits that optional family, so filter both declarations from
  // the staged aggregate only. The source checkout and pnpm build remain
  // untouched; the resulting store artifact is self-consistent.
  if (pkgName === '@linxin666/dsh-web-ui-all') {
    const patchPath = join(dst, 'cordis.patch.yml')
    const patch = readFileSync(patchPath, 'utf8')
    const filteredPatch = patch.replace(
      /# from \.\.\/dsh-liangshen\n- insert:\n    - id: web-ui-liangshen\n      name: '@linxin666\/dsh-liangshen'\n\n?/,
      '',
    )
    writeFileSync(patchPath, filteredPatch)
    if (pj.dependencies?.['@linxin666/dsh-liangshen'] !== undefined) {
      delete pj.dependencies['@linxin666/dsh-liangshen']
      writeFileSync(packageJsonPath, `${JSON.stringify(pj, null, 2)}\n`)
    }
  }
}

// Flatten the runtime closure. The monorepo was installed with
// --shamefully-hoist, so every transitive dependency has a top-level entry in
// node_modules; we dereference each pnpm symlink into a real directory copy.
const NM = join(ROOT, 'node_modules')
const seen = new Set()
function visit(name) {
  if (seen.has(name)) return
  seen.add(name)
  const real = realpathSync(join(NM, name))
  const dst = join(OUT, 'deps', name)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(real, dst, { recursive: true, dereference: true })
  const pjPath = join(real, 'package.json')
  if (!existsSync(pjPath)) return
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
  for (const dep of Object.keys(pj.dependencies ?? {})) visit(dep)
  // Optional native deps (cpu-features, bufferutil, utf-8-validate) are
  // intentionally skipped: each consumer has a JS fallback path.
}
for (const start of DEPS_START) visit(start)

// Manifests let the home-manager activation script replace exactly the dirs
// this derivation owns, without touching user files or skin symlinks created
// at runtime by the skin center.
writeFileSync(join(OUT, 'packages.manifest'), FAMILY.map(([, name]) => name).join('\n') + '\n')
writeFileSync(join(OUT, 'deps.manifest'), [...seen].sort().join('\n') + '\n')

console.log(`staged ${FAMILY.length} family packages and ${seen.size} dependency dirs`)
