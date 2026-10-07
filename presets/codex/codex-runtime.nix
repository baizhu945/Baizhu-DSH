{ pkgs ? import ../../pinned-nixpkgs.nix { }, lib ? pkgs.lib }:

# Private preset runtime, not an overlay or a replacement for pkgs.codex.
# Based on nixpkgs' codex recipe. Use upstream release-prepared source:
# a raw main checkout reports Cargo's 0.0.0 placeholder to the backend, which
# rejects Luna (minimum official client 0.155.0) despite successful OAuth.
let
  rev = "260f9619e07037e307a09eab0ed1bfeee86e725d";
  runtimeVersion = "0.162.0-alpha.11";
  platform = pkgs.stdenv.hostPlatform;
  v8Version = "150.4.0"; # codex-rs/Cargo.lock at rev
  v8ArchiveHashes = {
    x86_64-linux = "0v5hi3s56b6yk7nh5n0wygh7fn0j41yyjz5903r227qv0yvzssaq";
    aarch64-linux = "1lvx9xjzv7ibqvg5jnaxqaaim0lw4dwfgf6kw0pjfdrkmm97s5xp";
    riscv64-linux = "1lmx74mwavvx6rbwa7aq0pkjc58mxqy9hysbhpkhc3573360jdjh";
    aarch64-darwin = "043bgs3hcvrn1yzknrxchqnki8r9p7ggk9zbiaqwa8mqhlagin6c";
  };
  v8BindingHashes = {
    x86_64-linux = "01l53l6nk4p5brpz2v3svqijx3hz5nqry8q7x12vdgbrwim849vp";
    aarch64-linux = "01l53l6nk4p5brpz2v3svqijx3hz5nqry8q7x12vdgbrwim849vp";
    riscv64-linux = "01l53l6nk4p5brpz2v3svqijx3hz5nqry8q7x12vdgbrwim849vp";
    aarch64-darwin = "0krrb2vh4skvfmzwpcqkl55bg2gyn943drqa8snp16lwz06dynna";
  };
  v8Release = "https://github.com/denoland/rusty_v8/releases/download/v${v8Version}";
  v8Archive = pkgs.fetchurl {
    name = "librusty_v8-${v8Version}";
    url = "${v8Release}/librusty_v8_release_${platform.rust.rustcTarget}.a.gz";
    sha256 = v8ArchiveHashes.${platform.system};
  };
  v8Binding = pkgs.fetchurl {
    name = "src_binding-${v8Version}";
    url = "${v8Release}/src_binding_release_${platform.rust.rustcTarget}.rs";
    sha256 = v8BindingHashes.${platform.system};
  };
in
pkgs.rustPlatform.buildRustPackage (finalAttrs: {
  pname = "codex-preset-runtime";
  version = runtimeVersion;

  src = pkgs.fetchFromGitHub {
    owner = "openai";
    repo = "codex";
    inherit rev;
    hash = "sha256-Y5jLECmUrAGQ1XXCqXFMZp3wAv1oW46xv4MrrU5/mCY=";
  };
  sourceRoot = "${finalAttrs.src.name}/codex-rs";
  cargoHash = "sha256-W4iCsMR7yQtxzy2soMEkNjGWq7jKwLTnER1U0aePHLA=";

  __structuredAttrs = true;
  cargoBuildFlags = [
    "--package" "codex-cli"
    "--package" "codex-code-mode-host"
  ];

  # Private binary only: do not freeze or rewrite the official live catalog.
  # The one runtime patch changes only the two known-small context fields.
  patches = [ ./patches/codex-context-only.patch ];
  patchFlags = [ "-p1" "--fuzz=0" ];

  # Deliberately no nixpkgs no-daemon_auto_start.patch: it disables a stable
  # upstream feature. Retain the same compile-time resource workarounds.
  postPatch = ''
    substituteInPlace Cargo.toml \
      --replace-fail 'lto = "thin"' "" \
      --replace-fail 'codegen-units = 4' ""
    sed -i '1i#![recursion_limit = "256"]' chatgpt/src/lib.rs
  '';

  nativeBuildInputs = with pkgs; [
    clang cmake gitMinimal installShellFiles makeBinaryWrapper pkg-config
  ];
  buildInputs = with pkgs; [ libclang openssl ]
    ++ lib.optionals platform.isLinux [ libcap ];

  env = {
    # Build provenance only. The request/client version comes from upstream's
    # release-prepared Cargo workspace version, not this Git stamp.
    STABLE_GIT_COMMIT = rev;
    LIBCLANG_PATH = "${lib.getLib pkgs.libclang}/lib";
    NIX_CFLAGS_COMPILE = toString (
      lib.optionals pkgs.stdenv.cc.isGNU [ "-Wno-error=stringop-overflow" ]
      ++ lib.optionals pkgs.stdenv.cc.isClang [ "-Wno-error=character-conversion" ]
    );
    RUSTY_V8_ARCHIVE = v8Archive;
    RUSTY_V8_SRC_BINDING_PATH = v8Binding;
    # Avoid release debug-info RAM/disk pressure; runtime semantics unchanged.
    CARGO_PROFILE_RELEASE_DEBUG = "0";
  } // lib.optionalAttrs platform.isDarwin {
    NIX_CFLAGS_LINK = "-fuse-ld=${lib.getExe' pkgs.lld "ld64.lld"}";
  };

  # Also cap workers when Home Manager invokes Nix with its default core count.
  preBuild = ''
    if [ "$NIX_BUILD_CORES" -eq 0 ] || [ "$NIX_BUILD_CORES" -gt 6 ]; then
      export NIX_BUILD_CORES=6
    fi
  '';

  # As in nixpkgs, upstream tests need networking and non-sandboxed shells.
  doCheck = false;
  postInstall = lib.optionalString (pkgs.stdenv.buildPlatform.canExecute platform) ''
    installShellCompletion --cmd codex \
      --bash <($out/bin/codex completion bash) \
      --fish <($out/bin/codex completion fish) \
      --zsh <($out/bin/codex completion zsh)
  '';
  postFixup = ''
    wrapProgram $out/bin/codex --prefix PATH : ${lib.makeBinPath (
      [ pkgs.ripgrep ] ++ lib.optionals platform.isLinux [ pkgs.bubblewrap ]
    )}
  '';

  doInstallCheck = pkgs.stdenv.buildPlatform.canExecute platform;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/install-check-home"
    export CODEX_HOME="$HOME/.codex"
    mkdir -p "$HOME"
    # Check the real wire-effective release version, not merely Git provenance.
    grep -Fx 'version = "${runtimeVersion}"' Cargo.toml
    $out/bin/codex --version | grep -Fx 'codex-cli ${runtimeVersion}'
    $out/bin/codex app-server --help >/dev/null
    $out/bin/codex-code-mode-host --help >/dev/null
    runHook postInstallCheck
  '';

  passthru = {
    inherit rev v8Version runtimeVersion;
    # Retained by the preset's Home Manager build-input link farm.
    buildSources = [ v8Archive v8Binding ];
  };
  meta = {
    description = "Pinned upstream Codex CLI/app-server and code-mode host for the Codex preset";
    homepage = "https://github.com/openai/codex";
    license = lib.licenses.asl20;
    mainProgram = "codex";
    platforms = builtins.attrNames v8ArchiveHashes;
    sourceProvenance = with lib.sourceTypes; [ fromSource binaryNativeCode ];
  };
})
