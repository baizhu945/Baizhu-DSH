{ pkgs, lib, dsh, dshReaRuntime, ... }:

let
  inherit (import ../../environment.nix { }) keepBuildInputs;

  # Independent DSH recipe; do not import any Pi module or source file.
  # Ambient packages deliberately do not change DSH's pinned build/toolchain.
  rea = import ./rea-package.nix { inherit pkgs; };
  readonlyRoot = dsh;
  hostPackageJson = "${readonlyRoot}/apps/cli/package.json";
  effects = pkgs.runCommand "dsh-rea-tool-effects.json" {
    nativeBuildInputs = [ pkgs.nodejs ];
  } ''
    node --input-type=module - "${rea}/lib/rea-agents/dist/contracts/toolEffects.js" "$out" <<'NODE'
    import { writeFileSync } from 'node:fs'
    import { pathToFileURL } from 'node:url'
    const { TOOL_EFFECTS } = await import(pathToFileURL(process.argv[2]).href)
    if (Object.keys(TOOL_EFFECTS).length !== 138) throw new Error('REA effects catalog is incomplete')
    writeFileSync(process.argv[3], JSON.stringify(TOOL_EFFECTS))
    NODE
  '';
  systemPackageConfigJson = builtins.toJSON {
    inherit hostPackageJson;
    effectsPath = "${effects}";
    expectedTools = 138;
    serverName = "rea";
    command = "${rea}/bin/rea";
    args = [ "mcp" ];
    env = {
      GHIDRA_INSTALL_DIR = "${pkgs.ghidra}/lib/ghidra";
      JAVA_HOME = "${pkgs.jdk21}";
      REA_ANALYSIS_PROVIDER = "ghidra";
      REA_GHIDRA_STARTUP_TIMEOUT_MS = "1800000";
      GHIDRA_HEADLESS_MAXMEM = "8G";
      REA_BROWSER_EXECUTABLE = "${pkgs.chromium}/bin/chromium";
      REA_EVM_PRLIMIT_COMMAND = "${pkgs.util-linux}/bin/prlimit";
      REA_LOG_LEVEL = "silent";
    };
    # Outer MCP call budget must exceed Ghidra's complete startup analysis.
    toolCallTimeoutMs = 1860000;
  };
  bootstrapComposition = pkgs.replaceVars ./agent.cordis.yml.in {
    inherit systemPackageConfigJson;
  };

  # Take baseline entry metadata (including !!js, groups, isolate, disabled
  # rows and numeric config) from the same host that executes this preset.
  # Never flatten a group or copy global/profile settings into the preset.
  composition = pkgs.runCommand "dsh-rea-agent.cordis.yml" {
    nativeBuildInputs = [ pkgs.nodejs_22 ];
  } ''
    node --input-type=module - "${hostPackageJson}" \
      "${readonlyRoot}/packages/bundle/web-app/presets/standard.patch.yml" \
      "${bootstrapComposition}" "$out" <<'NODE'
    import { readFileSync, writeFileSync } from 'node:fs'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    const [anchor, standardPath, bootstrapPath, output] = process.argv.slice(2)
    const require = createRequire(anchor)
    const yaml = require('js-yaml')
    const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
    const patches = yaml.load(readFileSync(standardPath, 'utf8'), { schema: entryListSchema })
    const standard = patches.flatMap(patch => patch.insert ?? [])
      .find(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === 'standard')
    if (!Array.isArray(standard?.config?.plugins)) throw new Error('rea: host standard declaration missing')
    const bootstrap = yaml.load(readFileSync(bootstrapPath, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(bootstrap) || bootstrap.length !== 1 || bootstrap[0].id !== 'rea-bootstrap') {
      throw new Error('rea: invalid bootstrap entry list')
    }
    writeFileSync(output, '# Host standard baseline + lazy REA bootstrap; not a default.\n' +
      yaml.dump([...standard.config.plugins, ...bootstrap], { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
    NODE
  '';
  registrarPatch = pkgs.writeText "dsh-rea-registrar.patch.yml" ''
    - insert:
        - id: rea-registrar
          name: './plugins/rea-registrar.mjs'
          inject: [agentPresets, loader]
          config:
            hostPackageJson: '${hostPackageJson}'
  '';
in
{
  # Exposed only for the parent's independent wiring/tests, never environment.
  _module.args.dshRea = {
    inherit rea readonlyRoot hostPackageJson systemPackageConfigJson composition registrarPatch;
  };

  home.file = {
    ".dsh/.agent-presets/rea/agent.cordis.yml".source = composition;
    ".dsh/.agent-presets/rea/preset.yml".source = ./preset.yml;
    ".dsh/.agent-presets/rea/README.md".source = ./README.md;
    ".local/share/dsh-nix-build-inputs/rea".source = keepBuildInputs {
      inherit pkgs;
      name = "dsh-rea";
      packages = [ rea ];
      extraInputs = [ pkgs.path readonlyRoot rea.npmDeps dshReaRuntime ];
    };
  };

  # A runtime DIRECTORY, including rea-runtime.mjs and its private bootstrap
  # dependency, supplied by the parent. Real copy keeps relative/bare imports
  # under ~/.dsh; never bundle a second host SDK/Cordis inside that directory.
  # Runtime must resolve host SDK imports via hostPackageJson/shared profiles.
  home.activation.dshRea = lib.hm.dag.entryAfter [
    "linkGeneration" "dshRuntimePatches" "dshPlugins" "dshTui"
  ] ''
    reaRoot="$HOME/.dsh/.agent-presets/rea"
    runtime="$reaRoot/runtime"
    run mkdir -p "$reaRoot"
    if [ -L "$runtime" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$runtime"
    elif [ -d "$runtime" ]; then
      run chmod -R u+rwX "$runtime"
      run /run/current-system/sw/bin/remove-without-permission -rf "$runtime"
    fi
    run mkdir -p "$runtime"
    run cp -rL --no-preserve=mode ${dshReaRuntime}/. "$runtime/"
    run test -f "$runtime/rea-runtime.mjs"

    # These three real registrar copies are owned exclusively by this module.
    # Desktop discovers .agent-presets/rea itself; do not add a Desktop row.
    # Upstream headless has no preset registry and must remain unchanged.
    for profile in web dsh-tui; do
      profileRoot="$HOME/.dsh/profiles/$profile"
      run mkdir -p "$profileRoot/plugins"
      registrar="$profileRoot/plugins/rea-registrar.mjs"
      if [ -L "$registrar" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$registrar"
      fi
      run install -m 644 ${./rea-registrar.mjs} "$registrar"

      # Atomic replace, including any former HM symlink. Only the REA id is
      # reconciled; unrelated rows/expressions/defaults keep their semantics.
      # Fail closed on malformed config instead of reseeding a user's patch.
      run ${pkgs.nodejs_22}/bin/node --input-type=module - \
        "${hostPackageJson}" "${registrarPatch}" "$profileRoot/cordis.patch.yml" <<'NODE'
      import { existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
      import { createRequire } from 'node:module'
      import { pathToFileURL } from 'node:url'
      const [anchor, template, target] = process.argv.slice(2)
      const require = createRequire(anchor)
      const yaml = require('js-yaml')
      const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
      const options = { schema: entryListSchema }
      const oldText = existsSync(target) ? readFileSync(target, 'utf8') : '[]\n'
      const existing = yaml.load(oldText, options)
      const managed = yaml.load(readFileSync(template, 'utf8'), options)
      if (!Array.isArray(existing) || !Array.isArray(managed)) {
        throw new Error('rea: expected YAML patch lists; refusing to overwrite runtime settings')
      }
      const owned = row => row?.id === 'rea-registrar'
      const filterEntries = entries => entries.filter(row => !owned(row)).map(row =>
        row?.group && Array.isArray(row.config) ? { ...row, config: filterEntries(row.config) } : row)
      const retained = existing.filter(patch => !owned(patch)).flatMap(patch => {
        if (!Array.isArray(patch?.insert)) return [patch]
        const insert = filterEntries(patch.insert)
        if (insert.length === patch.insert.length) return [patch]
        if (insert.length) return [{ ...patch, insert }]
        // Drop an emptied insert-only wrapper, not unrelated patch metadata.
        const { insert: _, ...rest } = patch
        return Object.keys(rest).length ? [{ ...rest, insert }] : []
      })
      const nextRows = [...retained, ...managed]
      // Skip all rewrites when this exact managed row is already present.
      const next = yaml.dump(nextRows, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
      const canonicalOld = yaml.dump(existing, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
      if (next !== canonicalOld || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
        const mode = existsSync(target) ? (statSync(target).mode & 0o777) | 0o600 : 0o644
        writeFileSync(target + '.rea.tmp', next, { mode })
        renameSync(target + '.rea.tmp', target)
      }
    NODE
    done
  '';
}
