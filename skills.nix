{ config, pkgs, lib, ... }:

let
  anbeime-skills-repo = pkgs.fetchgit {
    url = "https://github.com/anbeime/skill.git";
    rev = "b78cb5a8f5b3f26df9f9f0fcd26410a355ec7290";
    hash = "sha256-UHWZJ591F6GCvnpzUuG7zaAduIsEEbFuc/rwGOhUs0c=";
  };

  anthropics-skills-repo = pkgs.fetchgit {
    url = "https://github.com/anthropics/skills.git";
    rev = "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f";
    hash = "sha256-sjgPv9tZZVTXPxZWaCOc7JwFceNn3C1ghy8mSHqgqB8=";
  };

  agent-skills-repo = pkgs.fetchgit {
    url = "https://github.com/addyosmani/agent-skills.git";
    rev = "469d00f4e67ff4a21eb6e6e467a086c9a1f1deb8";
    hash = "sha256-kNj6pdQK6BK4bhozJbcEf7raYc+D2VLnGkm4bYEJlDs=";
  };

  # obra/superpowers：软件开发方法论技能集（与 pi.nix 的 packages 中的
  # "git:github.com/obra/superpowers" 同源）。固定 rev + sha256 保证可复现；
  # dsh 无 pi 那样的包机制，等价做法是把 skills/ 下每个技能目录软链到
  # ~/.dsh/skills/（dsh 自动发现，rank 400 用户级）。
  # using-superpowers 技能即启动引导（pi 由扩展注入 bootstrap，dsh 由技能目录
  # 在会话目录中呈现，模型按"任务匹配技能必须调用"规则自行加载）。
  superpowers-repo = pkgs.fetchgit {
    url = "https://github.com/obra/superpowers.git";
    rev = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
    hash = "sha256-EsGNO0dULWf5Bx6bGrCv2kI2Z8aKH0kRvGiuN23wChQ=";
  };
in
{
  home.file = {
    # ---- 本地技能（agent/skills/）----
    ".dsh/skills/" = {
      source = ../skills;
      recursive = true;
    };

    # ---- anthropics/skills ----
    ".dsh/skills/docx" = {
      source = "${anthropics-skills-repo}/skills/docx";
      recursive = true;
    };
    ".dsh/skills/pptx" = {
      source = "${anthropics-skills-repo}/skills/pptx";
      recursive = true;
    };
    ".dsh/skills/xlsx" = {
      source = "${anthropics-skills-repo}/skills/xlsx";
      recursive = true;
    };
    ".dsh/skills/pdf" = {
      source = "${anthropics-skills-repo}/skills/pdf";
      recursive = true;
    };
    ".dsh/skills/canvas-design" = {
      source = "${anthropics-skills-repo}/skills/canvas-design";
      recursive = true;
    };
  };
}
